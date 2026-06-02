/**
 * ScrollbackBuffer — a byte-capped ring of PTY output chunks, used to replay
 * recent terminal output to a (re)connecting client.
 *
 * We cap by bytes rather than lines because ANSI output line lengths vary wildly,
 * and a byte cap keeps memory predictable (research/windows-pty-terminal-bridge.md
 * §2, matching wootty's 5 MiB byte cap over open-claude-remote's 50k-line cap).
 *
 * Each chunk carries a monotonically increasing `seq`. PR2 uses it for
 * lastSeq/replay resume; PR1 just needs it stable and increasing.
 */

export interface OutputChunk {
  readonly seq: number;
  readonly data: string;
}

/**
 * Result of a delta query for reconnect replay (PR2).
 *
 * `chunks` are the buffered chunks with `seq > since`, oldest first. `truncated`
 * is true when the client's requested `since` is older than anything still in the
 * buffer — i.e. some output between `since` and the oldest retained chunk has been
 * evicted, so the client has a gap it cannot fill incrementally and must reset.
 */
export interface ScrollbackDelta {
  readonly chunks: OutputChunk[];
  readonly truncated: boolean;
}

export class ScrollbackBuffer {
  private readonly maxBytes: number;
  private chunks: OutputChunk[] = [];
  private byteLength = 0;
  private seqCounter = 0;

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(1, maxBytes);
  }

  /** Append a chunk, assign it the next seq, and evict oldest chunks past the cap. */
  push(data: string): OutputChunk {
    this.seqCounter += 1;
    const chunk: OutputChunk = { seq: this.seqCounter, data };
    this.chunks.push(chunk);
    this.byteLength += byteSize(data);
    this.evict();
    return chunk;
  }

  /** seq of the most recent chunk, or 0 if empty. */
  get lastSeq(): number {
    return this.seqCounter;
  }

  /** seq of the oldest chunk still buffered, or 0 if empty. */
  get firstSeq(): number {
    return this.chunks.length > 0 ? this.chunks[0]!.seq : 0;
  }

  /** Current buffered size in bytes (after eviction). */
  get size(): number {
    return this.byteLength;
  }

  /** Number of buffered chunks. */
  get length(): number {
    return this.chunks.length;
  }

  /** A shallow copy of the buffered chunks, oldest first. */
  snapshot(): OutputChunk[] {
    return this.chunks.slice();
  }

  /**
   * Chunks newer than `since` (i.e. `seq > since`), oldest first, for reconnect
   * replay (PR2). The client passes the highest seq it has already rendered.
   *
   * `truncated` is true when the requested `since` falls into an already-evicted
   * region (`since` < `firstSeq - 1` while a non-empty buffer exists, but the
   * chunk immediately after `since` is gone): the incremental stream the client
   * expects has a hole, so the caller should reset the client and replay the full
   * current buffer instead of silently appending and leaving a gap.
   *
   * `since <= 0` means "I have nothing yet" → full buffer, never truncated.
   */
  since(since: number): ScrollbackDelta {
    if (since <= 0) {
      return { chunks: this.chunks.slice(), truncated: false };
    }
    // Already up to date (or ahead, e.g. after a server restart reset the seq):
    // nothing newer to send, no gap.
    if (since >= this.seqCounter) {
      return { chunks: [], truncated: false };
    }
    // The next chunk the client needs is `since + 1`. If that seq was evicted
    // (it's older than the oldest retained chunk), there is an unfillable gap.
    const truncated = this.chunks.length > 0 && this.firstSeq > since + 1;
    const chunks = this.chunks.filter((chunk) => chunk.seq > since);
    return { chunks, truncated };
  }

  /** Buffered output concatenated into a single string (oldest first). */
  concat(): string {
    let out = "";
    for (const chunk of this.chunks) out += chunk.data;
    return out;
  }

  private evict(): void {
    // Drop oldest chunks until we're under the byte cap, but always keep at least
    // one chunk so a single oversized chunk doesn't leave the buffer empty.
    while (this.byteLength > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (dropped) this.byteLength -= byteSize(dropped.data);
    }
  }
}

/** UTF-8 byte length of a string without allocating a Buffer per call where avoidable. */
function byteSize(data: string): number {
  return Buffer.byteLength(data, "utf8");
}
