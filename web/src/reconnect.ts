/**
 * Pure reconnect/replay helpers for BridgeClient — no DOM, so they're unit
 * testable in isolation (web/src/reconnect.test.ts). The stateful socket/timer
 * wiring lives in bridge-client.ts; the arithmetic and seq bookkeeping live here.
 */

import { Backoff } from "./protocol.js";

/**
 * Exponential backoff delay for reconnect attempt `attempt` (0-based), capped.
 * Mirrors wootty: `min(maxMs, baseMs * factor^attempt)` (research §4).
 */
export function backoffDelayMs(attempt: number): number {
  const raw = Backoff.baseMs * Math.pow(Backoff.factor, Math.max(0, attempt));
  return Math.min(Backoff.maxMs, Math.round(raw));
}

/**
 * Track the highest output seq rendered, enforcing "seq must strictly advance".
 * This is what makes the replay→live boundary safe: an overlapping replayed
 * chunk is dropped, a genuinely newer chunk is accepted exactly once. A
 * truncation reset rewinds the cursor to 0 so the full replay is re-rendered.
 */
export class SeqCursor {
  private seq: number;

  constructor(initial = 0) {
    this.seq = initial;
  }

  get value(): number {
    return this.seq;
  }

  /** Returns true (and advances) iff `seq` is newer than everything seen so far. */
  accept(seq: number): boolean {
    if (seq > this.seq) {
      this.seq = seq;
      return true;
    }
    return false;
  }

  /** Rewind to 0 — used on a `truncated` ready before a full-buffer replay. */
  reset(): void {
    this.seq = 0;
  }
}
