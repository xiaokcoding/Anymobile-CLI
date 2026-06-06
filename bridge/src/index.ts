/**
 * mobile-ssh bridge — entry point.
 *
 * Spawns Claude Code in a Windows-native node-pty(ConPTY) pseudo-terminal, holds
 * a persistent PTY + byte-ring scrollback, and mirrors it to the xterm.js client
 * over WebSocket (output ↓ / input · resize ↑). Reconnect/replay (PR2),
 * PWA/Tailscale (PR3), and approval/notification hooks (PR4) build on top.
 *
 * PR4: a capability-URL token gates the ws + cc hook endpoints; an
 * ApprovalRegistry holds pending PreToolUse approvals (resolved by ntfy button,
 * PWA card, or fail-closed timeout); ntfy carries outbound push.
 *
 * Requirements / decisions / research:
 *   .trellis/tasks/06-01-mobile-remote-control-app-for-claude-code-mvp/
 */

import { existsSync } from "node:fs";
import { loadConfig, tokenIsEphemeral } from "./config.js";
import { PtySession } from "./pty-session.js";
import { TerminalServer } from "./ws-server.js";
import { WEB_DIST_MISSING_HINT } from "./static-server.js";
import { ApprovalRegistry } from "./approval.js";
import { NtfyClient } from "./ntfy.js";

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

  // PR4 approval stack: registry of pending PreToolUse approvals + ntfy push.
  const approvals = new ApprovalRegistry({
    timeoutMs: config.approvalTimeoutMs,
    timeoutDecision: config.approvalTimeoutDecision,
  });
  const ntfy = new NtfyClient({ server: config.ntfyServer, topic: config.ntfyTopic });

  const server = new TerminalServer(session, {
    port: config.port,
    webDist: config.webDist,
    approval: {
      token: config.token,
      approvals,
      ntfy,
      approvalBaseUrl: config.approvalBaseUrl,
    },
  });
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

  // Print the capability URL so the user can open it / scan it. A wildcard host
  // is shown because the bridge doesn't know its own tailnet name; the path +
  // token are what matter. WARN loudly if the token is ephemeral (no BRIDGE_TOKEN
  // set) — the link breaks on every restart, which is a footgun for a long-lived
  // session. The token is logged ONLY to the local console (loopback bridge).
  console.log(
    `[mobile-ssh] capability URL (open on your phone, behind tailscale serve):\n` +
      `             https://<host>.<tailnet>.ts.net/?token=${config.token}\n` +
      `             (or locally: http://127.0.0.1:${server.port}/?token=${config.token})`,
  );
  if (tokenIsEphemeral()) {
    console.warn(
      "[mobile-ssh] BRIDGE_TOKEN is not set — a random token was generated and will " +
        "change on every restart, invalidating saved links. Set BRIDGE_TOKEN to keep it stable.",
    );
  }
  if (!ntfy.enabled) {
    console.warn(
      "[mobile-ssh] NTFY_TOPIC is not set — push notifications are disabled " +
        "(approvals still work via the PWA card).",
    );
  } else if (!config.approvalBaseUrl) {
    console.warn(
      "[mobile-ssh] APPROVAL_BASE_URL is not set — ntfy pushes will have no " +
        "allow/deny buttons; approve from the PWA card. Set it to your https://<host>.<tailnet>.ts.net.",
    );
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
