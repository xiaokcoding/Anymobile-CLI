/**
 * WebSocket wire protocol — client mirror of bridge/src/protocol.ts.
 *
 * Kept as a standalone copy (the bridge and web are separate packages with no
 * shared lib in the MVP). If this drifts from the bridge, the terminal mirror
 * breaks — keep the two `type` unions, the shared constants, and the field
 * shapes in sync. See bridge/src/protocol.ts for the full PR2 reconnect/replay +
 * heartbeat contract.
 */

/** WebSocket close codes (wootty contract, research §4). */
export const CloseCode = {
  ManualReconnect: 4101,
  NewSession: 4102,
  PongTimeout: 4103,
} as const;

/** Heartbeat tuning shared by both ends (wootty contract, research §4). */
export const Heartbeat = {
  /** Client sends a `ping` every this many ms. */
  intervalMs: 12_000,
  /** Grace window before a side declares the link dead (~2 intervals). */
  timeoutMs: 24_000,
} as const;

/** Reconnect backoff tuning (wootty contract, research §4). */
export const Backoff = {
  baseMs: 300,
  factor: 1.8,
  maxMs: 5_000,
} as const;

export type ServerMessage =
  | { type: "ready"; cols: number; rows: number; lastSeq: number; alive: boolean; truncated: boolean }
  | { type: "output"; seq: number; data: string }
  | { type: "exit"; code: number; signal: number | undefined }
  | { type: "pong" };

export type ClientMessage =
  | { type: "attach"; lastSeq: number }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" };

export function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const msg = value as Record<string, unknown>;
  switch (msg.type) {
    case "ready":
      return typeof msg.cols === "number" &&
        typeof msg.rows === "number" &&
        typeof msg.lastSeq === "number" &&
        typeof msg.alive === "boolean" &&
        typeof msg.truncated === "boolean"
        ? {
            type: "ready",
            cols: msg.cols,
            rows: msg.rows,
            lastSeq: msg.lastSeq,
            alive: msg.alive,
            truncated: msg.truncated,
          }
        : null;
    case "output":
      return typeof msg.seq === "number" && typeof msg.data === "string"
        ? { type: "output", seq: msg.seq, data: msg.data }
        : null;
    case "exit":
      return typeof msg.code === "number"
        ? { type: "exit", code: msg.code, signal: typeof msg.signal === "number" ? msg.signal : undefined }
        : null;
    case "pong":
      return { type: "pong" };
    default:
      return null;
  }
}

export function serializeClientMessage(msg: ClientMessage): string {
  return JSON.stringify(msg);
}
