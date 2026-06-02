/**
 * Bridge configuration — all knobs come from the environment so the bridge can
 * be tuned without code changes. Defaults match the PR1 decisions in
 * .trellis/tasks/06-01-mobile-remote-control-app-for-claude-code-mvp/prd.md.
 */

import { defaultWebDist } from "./static-server.js";

/** Parse an env var as a positive integer, falling back to `fallback` when unset/invalid. */
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
}

export function loadConfig(): BridgeConfig {
  return {
    port: intFromEnv("BRIDGE_PORT", 8866),
    scrollbackBytes: intFromEnv("SCROLLBACK_BYTES", 4 * 1024 * 1024),
    charDelayMs: intFromEnv("CLAUDE_CHAR_DELAY_MS", 15),
    cwd: process.env.BRIDGE_CWD?.trim() || process.cwd(),
    webDist: process.env.WEB_DIST?.trim() || defaultWebDist(),
  };
}
