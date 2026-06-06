/**
 * WebSocket wire protocol — client mirror of bridge/src/protocol.ts.
 *
 * This is a MIRROR, not a byte-identical copy: it describes the same wire
 * contract from the client's end (parses inbound SERVER frames, serializes
 * CLIENT frames — the reverse of the bridge). The bridge and web are separate
 * packages with no shared lib in the MVP, so if the two drift the terminal
 * mirror breaks — keep the two `type` unions, the shared constants (CloseCode /
 * Heartbeat / Backoff), and every field shape in sync. See bridge/src/protocol.ts
 * for the full PR2 reconnect/replay + heartbeat contract and the PR4 approval
 * frames (`approval_request`/`approval_resolved` down, `approval_decision` up).
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

/** A permission decision the human (or a timeout) returns for a tool request. */
export type ApprovalDecision = "allow" | "deny" | "ask";

export type ServerMessage =
  | { type: "ready"; cols: number; rows: number; lastSeq: number; alive: boolean; truncated: boolean }
  | { type: "output"; seq: number; data: string }
  | { type: "exit"; code: number; signal: number | undefined }
  | { type: "pong" }
  | { type: "approval_request"; id: string; toolName: string; toolInput: string; createdAt: number }
  | { type: "approval_resolved"; id: string; decision: ApprovalDecision };

export type ClientMessage =
  | { type: "attach"; lastSeq: number }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" }
  | { type: "approval_decision"; id: string; decision: ApprovalDecision };

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
    case "approval_request":
      return typeof msg.id === "string" &&
        typeof msg.toolName === "string" &&
        typeof msg.toolInput === "string" &&
        typeof msg.createdAt === "number"
        ? {
            type: "approval_request",
            id: msg.id,
            toolName: msg.toolName,
            toolInput: msg.toolInput,
            createdAt: msg.createdAt,
          }
        : null;
    case "approval_resolved":
      return typeof msg.id === "string" && isApprovalDecision(msg.decision)
        ? { type: "approval_resolved", id: msg.id, decision: msg.decision }
        : null;
    default:
      return null;
  }
}

export function serializeClientMessage(msg: ClientMessage): string {
  return JSON.stringify(msg);
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === "allow" || value === "deny" || value === "ask";
}
