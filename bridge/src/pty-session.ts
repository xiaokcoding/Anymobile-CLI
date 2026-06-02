/**
 * PtySession — owns one long-lived pseudo-terminal running Claude Code.
 *
 * The PTY lifecycle is decoupled from any WebSocket connection: clients attach
 * and detach freely; the PTY keeps running and its output keeps filling a
 * byte-capped scrollback ring so a reconnecting client can be replayed. This is
 * how we take over tmux's "session persistence" job without tmux
 * (research/windows-pty-terminal-bridge.md §2).
 *
 * Three load-bearing Windows fixes live here (prd.md "三大坑"):
 *   1. Input is fed to the PTY char-by-char with a small delay, so node-pty does
 *      not wrap a batched write in bracketed-paste markers — which makes Claude
 *      Code treat the trailing `\r` as pasted text and never submit the prompt.
 *   2. resize() is guarded by an `alive` flag (set false on exit) because a
 *      resize after the PTY exits throws inside node-pty's native async callback,
 *      bypassing JS try/catch and crashing the whole process (node-pty #827).
 *   3. ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are stripped from the child env so
 *      the spawned `claude` falls back to the subscription OAuth login instead of
 *      billing the API (prd.md Q5).
 */

import * as pty from "node-pty";
import { ScrollbackBuffer, type OutputChunk, type ScrollbackDelta } from "./scrollback.js";

export interface PtySessionOptions {
  /** Executable to spawn. On Windows for Claude Code this is `claude.cmd`. */
  readonly file: string;
  /** Arguments passed to the executable. */
  readonly args: readonly string[];
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string;
  /** Byte cap of the scrollback ring buffer. */
  readonly scrollbackBytes: number;
  /** Per-character input delay in ms (bracketed-paste mitigation). */
  readonly charDelayMs: number;
}

export interface PtyExit {
  readonly code: number;
  readonly signal: number | undefined;
}

type OutputListener = (chunk: OutputChunk) => void;
type ExitListener = (exit: PtyExit) => void;

/** Env vars that must NOT reach the child, or it bills the API instead of the subscription. */
const STRIPPED_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

export class PtySession {
  private readonly proc: pty.IPty;
  private readonly scrollback: ScrollbackBuffer;
  private readonly charDelayMs: number;

  private readonly outputListeners = new Set<OutputListener>();
  private readonly exitListeners = new Set<ExitListener>();

  /** False once the PTY has exited. Guards resize() against node-pty #827. */
  private aliveFlag = true;
  private exitInfo: PtyExit | null = null;

  /** Tail of the char-by-char write pump; all writes chain off this promise. */
  private writeChain: Promise<void> = Promise.resolve();

  private currentCols: number;
  private currentRows: number;

  constructor(options: PtySessionOptions) {
    this.charDelayMs = options.charDelayMs;
    this.scrollback = new ScrollbackBuffer(options.scrollbackBytes);
    this.currentCols = options.cols;
    this.currentRows = options.rows;

    this.proc = pty.spawn(options.file, [...options.args], {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      // Strip API-key envs so the child uses subscription OAuth (prd.md Q5).
      // Do NOT pass the deprecated `useConpty` — ConPTY auto-enables on build >= 18309.
      env: buildChildEnv(),
    });

    this.proc.onData((data) => {
      const chunk = this.scrollback.push(data);
      for (const listener of this.outputListeners) listener(chunk);
    });

    this.proc.onExit(({ exitCode, signal }) => {
      this.aliveFlag = false;
      this.exitInfo = { code: exitCode, signal };
      for (const listener of this.exitListeners) listener(this.exitInfo);
    });
  }

  get alive(): boolean {
    return this.aliveFlag;
  }

  get cols(): number {
    return this.currentCols;
  }

  get rows(): number {
    return this.currentRows;
  }

  /** seq of the most recent output chunk (0 when nothing has been emitted yet). */
  get lastSeq(): number {
    return this.scrollback.lastSeq;
  }

  /** seq of the oldest output chunk still buffered (0 when empty). */
  get firstSeq(): number {
    return this.scrollback.firstSeq;
  }

  get exit(): PtyExit | null {
    return this.exitInfo;
  }

  /** Snapshot of the buffered scrollback for replaying to a newly attached client. */
  snapshot(): OutputChunk[] {
    return this.scrollback.snapshot();
  }

  /**
   * Buffered chunks newer than `since` for incremental reconnect replay (PR2).
   * See ScrollbackBuffer.since for the gap/truncation semantics.
   */
  since(since: number): ScrollbackDelta {
    return this.scrollback.since(since);
  }

  onOutput(listener: OutputListener): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    // If the PTY already exited, notify immediately so late subscribers aren't stuck.
    if (this.exitInfo) listener(this.exitInfo);
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /**
   * Feed client input to the PTY one character at a time with a small delay.
   * Bracketed-paste mitigation (load-bearing fix #1). Calls are serialized via a
   * promise chain so interleaved writes can't corrupt the per-char timing.
   */
  write(data: string): void {
    if (!this.aliveFlag || data.length === 0) return;

    // Iterate by code point so multi-byte characters (CJK, emoji) aren't split.
    const chars = Array.from(data);
    this.writeChain = this.writeChain.then(async () => {
      for (const ch of chars) {
        if (!this.aliveFlag) return;
        this.proc.write(ch);
        if (this.charDelayMs > 0) await delay(this.charDelayMs);
      }
    });
    // Swallow rejections so one failed write doesn't poison the chain.
    this.writeChain = this.writeChain.catch(() => undefined);
  }

  /**
   * Resize the PTY. No-op (not an error) once the PTY has exited — resizing a
   * dead PTY throws inside node-pty's native async callback and bypasses JS
   * try/catch, crashing the process (load-bearing fix #2, node-pty #827).
   */
  resize(cols: number, rows: number): void {
    if (!this.aliveFlag) return;
    if (cols <= 0 || rows <= 0) return;
    try {
      this.proc.resize(cols, rows);
      this.currentCols = cols;
      this.currentRows = rows;
    } catch {
      // Defensive: a race where the PTY exits between the alive check and the
      // synchronous resize. The native async crash path is handled by `alive`.
    }
  }

  /** Kill the PTY. Safe to call multiple times. */
  kill(): void {
    if (!this.aliveFlag) return;
    try {
      this.proc.kill();
    } catch {
      // Already gone.
    }
  }
}

function buildChildEnv(): { [key: string]: string | undefined } {
  const env: { [key: string]: string | undefined } = { ...process.env };
  for (const key of STRIPPED_ENV_KEYS) delete env[key];
  return env;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
