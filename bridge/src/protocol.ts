/**
 * WebSocket wire protocol between bridge and the xterm.js client.
 *
 * Design (research/windows-pty-terminal-bridge.md §4): keep high-frequency PTY
 * output/input cheap, low-frequency control on small JSON. Every frame here is a
 * JSON envelope with a `type` tag — PR1 favoured clarity over the zero-overhead
 * raw-frame split; PR2 layers seq-based reconnect/replay + a heartbeat on top of
 * the same shape.
 *
 * `seq` is a monotonically increasing counter attached to each `output` chunk so
 * the client can resume from where it left off.
 *
 * PR2 reconnect/replay contract (numbers from wootty's "Transport Lifecycle
 * Contract", research §4):
 *   - The client opens the socket and sends `attach{lastSeq}` as its FIRST frame.
 *     `lastSeq` is the highest output seq it has already rendered (0 = nothing).
 *   - The bridge replies `ready{cols,rows,alive,lastSeq,truncated}` and then
 *     replays only the chunks with `seq > attach.lastSeq` as `output` frames.
 *     `truncated=true` means the requested range had already rolled out of the
 *     scrollback (an unfillable gap); the client must reset its terminal before
 *     writing the replayed (now full-buffer) output.
 *   - Heartbeat: the client sends `ping` every 12s; the bridge answers `pong`.
 *     The browser `WebSocket` has no protocol-level ping API, so we carry the
 *     heartbeat as app-layer JSON frames defined here. Either side treats a
 *     missing counterpart as a dead link (bridge closes 4103; client reconnects).
 *
 * IMPORTANT: keep this file byte-for-byte in sync with web/src/protocol.ts. The
 * two packages have no shared lib in the MVP; any new frame/field must land in
 * both or the terminal mirror breaks.
 */

/** WebSocket close codes (wootty contract, research §4). */
export const CloseCode = {
  /** Client asked for a manual reconnect. */
  ManualReconnect: 4101,
  /** Server is opening a new session and closing the old connection. */
  NewSession: 4102,
  /** Heartbeat timed out (no client ping within the pong window). */
  PongTimeout: 4103,
} as const;

/** Heartbeat tuning shared by both ends (wootty contract, research §4). */
export const Heartbeat = {
  /** Client sends a `ping` every this many ms. */
  intervalMs: 12_000,
  /**
   * Grace window before a side declares the link dead. We allow ~2 intervals so
   * one dropped frame doesn't tear down a healthy connection.
   */
  timeoutMs: 24_000,
} as const;

/** Reconnect backoff tuning for the client (wootty contract, research §4). */
export const Backoff = {
  baseMs: 300,
  factor: 1.8,
  maxMs: 5_000,
} as const;

/** Server → client messages. */
export type ServerMessage =
  | {
      readonly type: "ready";
      readonly cols: number;
      readonly rows: number;
      /** seq of the most recent output chunk the bridge holds (replay cursor). */
      readonly lastSeq: number;
      /** Whether the PTY is still alive at attach time. */
      readonly alive: boolean;
      /**
       * True when the client's requested `lastSeq` had already been evicted from
       * the scrollback, so the replay that follows is the full current buffer and
       * the client must reset its terminal first to avoid a gap.
       */
      readonly truncated: boolean;
    }
  | {
      readonly type: "output";
      readonly seq: number;
      readonly data: string;
    }
  | {
      readonly type: "exit";
      readonly code: number;
      readonly signal: number | undefined;
    }
  | {
      /** Heartbeat reply to a client `ping`. */
      readonly type: "pong";
    };

/** Client → server messages. */
export type ClientMessage =
  | {
      /**
       * First frame after the socket opens. Carries the highest output seq the
       * client already has so the bridge can replay only what's newer.
       */
      readonly type: "attach";
      readonly lastSeq: number;
    }
  | {
      readonly type: "input";
      readonly data: string;
    }
  | {
      readonly type: "resize";
      readonly cols: number;
      readonly rows: number;
    }
  | {
      /** Heartbeat probe; the bridge answers with `pong`. */
      readonly type: "ping";
    };

/** Type guard + parse for an inbound client frame. Returns null on anything malformed. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const msg = value as Record<string, unknown>;

  switch (msg.type) {
    case "attach":
      // lastSeq must be a non-negative integer; treat anything else as 0 (full replay).
      return { type: "attach", lastSeq: isNonNegativeInt(msg.lastSeq) ? msg.lastSeq : 0 };
    case "input":
      return typeof msg.data === "string" ? { type: "input", data: msg.data } : null;
    case "resize":
      return isPositiveInt(msg.cols) && isPositiveInt(msg.rows)
        ? { type: "resize", cols: msg.cols, rows: msg.rows }
        : null;
    case "ping":
      return { type: "ping" };
    default:
      return null;
  }
}

export function serializeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
