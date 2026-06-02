/**
 * mobile-ssh bridge — entry point (PR1: PTY core).
 *
 * Spawns Claude Code in a Windows-native node-pty(ConPTY) pseudo-terminal, holds
 * a persistent PTY + byte-ring scrollback, and mirrors it to the xterm.js client
 * over WebSocket (output ↓ / input · resize ↑). Reconnect/replay (PR2),
 * PWA/Tailscale (PR3), and approval/notification hooks (PR4) build on top.
 *
 * Requirements / decisions / research:
 *   .trellis/tasks/06-01-mobile-remote-control-app-for-claude-code-mvp/
 */

import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { PtySession } from "./pty-session.js";
import { TerminalServer } from "./ws-server.js";
import { WEB_DIST_MISSING_HINT } from "./static-server.js";

/** On Windows the Claude Code launcher is a `.cmd` shim; node-pty spawns it directly. */
const CLAUDE_COMMAND = process.platform === "win32" ? "claude.cmd" : "claude";

async function main(): Promise<void> {
  const config = loadConfig();

  const session = new PtySession({
    file: CLAUDE_COMMAND,
    args: [],
    cols: 80,
    rows: 24,
    cwd: config.cwd,
    scrollbackBytes: config.scrollbackBytes,
    charDelayMs: config.charDelayMs,
  });

  const server = new TerminalServer(session, { port: config.port, webDist: config.webDist });
  await server.whenListening();

  // The PWA and ws now share one port, so a single `tailscale serve --bg <port>`
  // fronts the whole origin (PR3). Warn (don't fail) if the PWA isn't built yet.
  const distBuilt = existsSync(config.webDist);
  console.log(
    `[mobile-ssh] bridge listening on http://127.0.0.1:${server.port} (PWA + ws) — ` +
      `front with: tailscale serve --bg ${server.port}`,
  );
  console.log(
    `[mobile-ssh] spawned ${CLAUDE_COMMAND} in ${config.cwd}, ` +
      `scrollback ${config.scrollbackBytes}B, char-delay ${config.charDelayMs}ms; ` +
      `web-dist ${distBuilt ? config.webDist : `MISSING (${config.webDist})`}`,
  );
  if (!distBuilt) {
    console.warn(`[mobile-ssh] ${WEB_DIST_MISSING_HINT}`);
  }

  session.onExit((exit) => {
    console.log(`[mobile-ssh] claude exited (code=${exit.code}, signal=${exit.signal ?? "none"}).`);
  });

  let shuttingDown = false;
  const shutdown = (sig: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[mobile-ssh] ${sig} received — shutting down.`);
    session.kill();
    void server.close().finally(() => {
      // node-pty's ConoutConnection worker isn't unref'd (issue #887), so the
      // event loop won't drain on its own after kill(). Force-exit.
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[mobile-ssh] fatal:", err);
  process.exit(1);
});
