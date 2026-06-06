/**
 * BridgeClient — a small self-written xterm.js ↔ WebSocket bridge with reconnect.
 *
 * We do NOT use @xterm/addon-attach: it has no resize and no replay semantics,
 * and we want explicit control over the message envelope (research §2/§4).
 *
 * PR2 adds the resilience layer on top of PR1's mirror:
 *   - Auto-reconnect with exponential backoff (300ms * 1.8^attempt, cap 5000ms;
 *     wootty contract, research §4).
 *   - App-layer heartbeat: send `ping` every 12s; if no `pong` (or any frame)
 *     arrives within the timeout window, drop the socket and reconnect. The
 *     browser `WebSocket` has no protocol-level ping, so the heartbeat rides the
 *     JSON envelope.
 *   - lastSeq resume: track the highest output seq rendered and send it in the
 *     `attach` frame so the bridge replays only what we missed. On a `truncated`
 *     ready (the bridge had already evicted our range) we reset() the terminal
 *     before writing the full replay, so we never silently leave a gap.
 *
 * Two PR1 carry-overs are fixed here:
 *   - Terminal/window listeners are registered ONCE in the constructor (not per
 *     connect), so reconnects don't stack duplicate input/resize handlers.
 *   - Output is de-duped by seq (seq must strictly advance) so the boundary
 *     between replayed and live chunks never repeats or drops a frame.
 */

import type { Terminal, IDisposable } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import {
  parseServerMessage,
  serializeClientMessage,
  Heartbeat,
  CloseCode,
  type ClientMessage,
  type ApprovalDecision,
} from "./protocol.js";
import { backoffDelayMs, SeqCursor } from "./reconnect.js";

export interface BridgeClientOptions {
  readonly url: string;
  readonly term: Terminal;
  readonly fit: FitAddon;
  /** Debounce window (ms) for coalescing resize events before sending. */
  readonly resizeDebounceMs?: number;
  /**
   * PR4: called when the bridge surfaces a new tool-permission request. The UI
   * (main.ts) renders an approval card; the user's tap calls
   * `sendApprovalDecision`.
   */
  readonly onApprovalRequest?: (req: {
    id: string;
    toolName: string;
    toolInput: string;
    createdAt: number;
  }) => void;
  /**
   * PR4: called when an approval is resolved via ANY channel (this card, another
   * client, an ntfy button, or the bridge timeout) so the UI clears the card.
   */
  readonly onApprovalResolved?: (id: string, decision: ApprovalDecision) => void;
}

export class BridgeClient {
  private readonly url: string;
  private readonly term: Terminal;
  private readonly fit: FitAddon;
  private readonly resizeDebounceMs: number;
  private readonly onApprovalRequest?: BridgeClientOptions["onApprovalRequest"];
  private readonly onApprovalResolved?: BridgeClientOptions["onApprovalResolved"];

  private socket: WebSocket | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  /** Backoff attempt counter; reset to 0 once a connection is established. */
  private reconnectAttempt = 0;
  /** Highest output seq we've rendered. Sent in `attach` to resume. */
  private readonly cursor = new SeqCursor(0);
  /** True after close()/destroy() so pending reconnects are cancelled. */
  private closed = false;

  /** Persistent terminal/window listeners, registered once (see class doc). */
  private readonly disposables: IDisposable[] = [];
  private readonly onWindowResize = (): void => this.scheduleResize();

  constructor(options: BridgeClientOptions) {
    this.url = options.url;
    this.term = options.term;
    this.fit = options.fit;
    this.resizeDebounceMs = options.resizeDebounceMs ?? 150;
    this.onApprovalRequest = options.onApprovalRequest;
    this.onApprovalResolved = options.onApprovalResolved;

    // Register input/resize listeners ONCE so reconnects don't stack duplicates.
    // Forward keystrokes / pasted text; the bridge feeds the PTY char-by-char.
    this.disposables.push(this.term.onData((data) => this.send({ type: "input", data })));
    this.disposables.push(this.term.onResize(({ cols, rows }) => this.sendResize(cols, rows)));
    window.addEventListener("resize", this.onWindowResize);
  }

  /** Open the connection. Safe to call once; reconnects are automatic. */
  connect(): void {
    this.closed = false;
    this.open();
  }

  /**
   * Send raw input to the PTY (PR3 mobile input box).
   *
   * Reuses the exact same `{ type: "input", data }` envelope that `term.onData`
   * sends — no protocol change, just a second producer for the existing path.
   * The bridge re-chunks `data` char-by-char (PR1 bracketed-paste fix), so the
   * caller passes the whole line at once (e.g. `prompt + "\r"`).
   *
   * Dropped silently if the socket isn't open; the user can retry once we
   * reconnect (the terminal already shows the disconnected banner).
   */
  sendInput(data: string): void {
    this.send({ type: "input", data });
  }

  /**
   * Reply to an approval card (PR4). The ws is already token-authed at the
   * handshake (capability URL), so this carries no per-request nonce — the bridge
   * resolves the pending approval `id` and broadcasts `approval_resolved` to every
   * client (including us) to clear the card.
   *
   * Dropped silently if the socket isn't open; the bridge's fail-closed timeout
   * still returns a decision to cc, and a reconnect will deliver the eventual
   * `approval_resolved` so the card doesn't hang forever.
   */
  sendApprovalDecision(id: string, decision: ApprovalDecision): void {
    this.send({ type: "approval_decision", id, decision });
  }

  /** Tear everything down: stop reconnecting, drop the socket, remove listeners. */
  destroy(): void {
    this.closed = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.close(CloseCode.ManualReconnect, "client destroyed");
      this.socket = null;
    }
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    window.removeEventListener("resize", this.onWindowResize);
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
  }

  private open(): void {
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      // Resume from where we left off; the bridge replays only seq > lastSeq.
      this.send({ type: "attach", lastSeq: this.cursor.value });
      // Match the bridge PTY to our viewport.
      this.fit.fit();
      this.sendResize(this.term.cols, this.term.rows);
      this.startHeartbeat();
    });

    socket.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      const msg = parseServerMessage(ev.data);
      if (!msg) return;
      switch (msg.type) {
        case "ready":
          // On a truncated replay the bridge had already evicted our range, so
          // the output that follows is the FULL current buffer. Reset first to
          // avoid leaving a gap of stale-on-top-of-fresh.
          if (msg.truncated) {
            this.term.reset();
            this.cursor.reset();
          }
          break;
        case "output":
          // De-dupe by seq: the replay→live boundary may overlap. Only render
          // frames strictly newer than what we've already shown.
          if (this.cursor.accept(msg.seq)) {
            this.term.write(msg.data);
          }
          break;
        case "pong":
          this.clearPongTimer();
          break;
        case "exit":
          this.term.write(`\r\n\x1b[33m[claude exited: code=${msg.code}]\x1b[0m\r\n`);
          break;
        case "approval_request":
          this.onApprovalRequest?.({
            id: msg.id,
            toolName: msg.toolName,
            toolInput: msg.toolInput,
            createdAt: msg.createdAt,
          });
          break;
        case "approval_resolved":
          this.onApprovalResolved?.(msg.id, msg.decision);
          break;
      }
    });

    socket.addEventListener("close", () => {
      this.stopHeartbeat();
      if (this.socket === socket) this.socket = null;
      if (this.closed) return;
      this.scheduleReconnect();
    });

    // `error` is followed by `close`; let close() drive the reconnect.
    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {
        // already closing/closed
      }
    });
  }

  // --- reconnect / backoff --------------------------------------------------

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = backoffDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.term.write(`\r\n\x1b[31m[disconnected — reconnecting in ${delay}ms]\x1b[0m\r\n`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.open();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // --- heartbeat ------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => this.sendPing(), Heartbeat.intervalMs);
  }

  private sendPing(): void {
    this.send({ type: "ping" });
    // Expect a `pong` within the window; otherwise treat the link as dead.
    if (this.pongTimer === null) {
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        // Force a reconnect: dropping the socket triggers the close handler.
        if (this.socket) this.socket.close(CloseCode.PongTimeout, "pong timeout");
      }, Heartbeat.timeoutMs);
    }
  }

  private clearPongTimer(): void {
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private stopHeartbeat(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearPongTimer();
  }

  // --- resize / send --------------------------------------------------------

  private scheduleResize(): void {
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.fit.fit();
    }, this.resizeDebounceMs);
  }

  private sendResize(cols: number, rows: number): void {
    this.send({ type: "resize", cols, rows });
  }

  private send(msg: ClientMessage): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(serializeClientMessage(msg));
    }
  }
}
