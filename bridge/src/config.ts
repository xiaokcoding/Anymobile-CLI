/**
 * Bridge configuration — all knobs come from the environment so the bridge can
 * be tuned without code changes. Defaults match the PR1 decisions in
 * .trellis/tasks/06-01-mobile-remote-control-app-for-claude-code-mvp/prd.md.
 */

import { randomUUID } from "node:crypto";
import { defaultWebDist } from "./static-server.js";

/** Parse an env var as a positive integer, falling back to `fallback` when unset/invalid. */
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Trimmed env string, or undefined when unset/blank. */
function strFromEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

/** A permission decision the bridge can return to a Claude Code PreToolUse hook. */
export type ApprovalDecision = "allow" | "deny" | "ask";

/** Parse the fail-closed default decision; anything but allow/ask falls back to deny. */
function decisionFromEnv(name: string, fallback: ApprovalDecision): ApprovalDecision {
  const raw = strFromEnv(name)?.toLowerCase();
  if (raw === "allow" || raw === "deny" || raw === "ask") return raw;
  return fallback;
}

export interface BridgeConfig {
  /** TCP port the bridge binds on (loopback only) — serves both the PWA and the ws. */
  readonly port: number;
  /** Byte cap of the scrollback ring buffer replayed to reconnecting clients. */
  readonly scrollbackBytes: number;
  /**
   * Per-character delay (ms) when feeding client input to the PTY. Required to
   * dodge node-pty's Windows bracketed-paste wrapping that otherwise eats
   * Claude Code's `\r` so prompts never submit. See research/windows-pty-terminal-bridge.md §1.
   */
  readonly charDelayMs: number;
  /** Working directory for the spawned `claude` process. */
  readonly cwd: string;
  /**
   * Directory of the built PWA (web/dist) served alongside the ws on the same
   * port, so one `tailscale serve --bg <port>` fronts a single origin (PR3).
   */
  readonly webDist: string;
  /**
   * Shared secret guarding the ws (capability URL `?token=`) AND the cc hook
   * endpoints (`Authorization: Bearer`). Set BRIDGE_TOKEN to keep the capability
   * URL stable across restarts — an unset token is regenerated every boot, which
   * invalidates every previously-shared link. See PR4 auth (research §5 / R2 §2.2).
   */
  readonly token: string;
  /** ntfy base URL for outbound push (default https://ntfy.sh). */
  readonly ntfyServer: string;
  /** ntfy topic to publish to. Unset → push is skipped (PWA cards still work). */
  readonly ntfyTopic: string | undefined;
  /**
   * Public base URL the phone reaches the bridge at through tailscale serve
   * (e.g. https://<host>.<tailnet>.ts.net). Used to build ntfy http-action
   * button URLs (`${base}/approvals/<id>`). Unset → push has no action buttons.
   */
  readonly approvalBaseUrl: string | undefined;
  /**
   * How long the bridge waits for a human decision before returning the
   * fail-closed default. MUST stay under the cc hook `timeout` (300s) so the
   * bridge always answers first; default 280s. (research/claude-code-hooks-approval §2.3)
   */
  readonly approvalTimeoutMs: number;
  /** Decision returned when an approval times out. Default deny (fail-closed). */
  readonly approvalTimeoutDecision: ApprovalDecision;
}

export function loadConfig(): BridgeConfig {
  const token = strFromEnv("BRIDGE_TOKEN");
  return {
    port: intFromEnv("BRIDGE_PORT", 8866),
    scrollbackBytes: intFromEnv("SCROLLBACK_BYTES", 4 * 1024 * 1024),
    charDelayMs: intFromEnv("CLAUDE_CHAR_DELAY_MS", 15),
    cwd: process.env.BRIDGE_CWD?.trim() || process.cwd(),
    webDist: process.env.WEB_DIST?.trim() || defaultWebDist(),
    // Stable secret if provided; otherwise a fresh one each boot (caller warns).
    token: token ?? randomUUID(),
    ntfyServer: strFromEnv("NTFY_SERVER") ?? "https://ntfy.sh",
    ntfyTopic: strFromEnv("NTFY_TOPIC"),
    approvalBaseUrl: stripTrailingSlash(strFromEnv("APPROVAL_BASE_URL")),
    approvalTimeoutMs: intFromEnv("APPROVAL_TIMEOUT_MS", 280_000),
    approvalTimeoutDecision: decisionFromEnv("APPROVAL_TIMEOUT_DECISION", "deny"),
  };
}

/** True when BRIDGE_TOKEN was not provided, so the boot-time token is ephemeral. */
export function tokenIsEphemeral(): boolean {
  return strFromEnv("BRIDGE_TOKEN") === undefined;
}

/** Drop a single trailing slash so `${base}/approvals/<id>` never double-slashes. */
function stripTrailingSlash(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
