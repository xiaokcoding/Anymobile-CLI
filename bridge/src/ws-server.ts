/**
 * WebSocket terminal server — mirrors a PtySession to any number of clients, and
 * (PR3) serves the built PWA over HTTP on the SAME port. A single Node
 * http.Server hosts both: HTTP GET serves web/dist (static-server.ts), and the
 * WebSocketServer is attached to that http.Server so ws Upgrade requests share
 * the port. Distinguished by the `Upgrade` header, so one
 * `tailscale serve --bg <port>` fronts the whole origin and the client's
 * same-origin `wss://<host>` works (web/src/main.ts resolveBridgeUrl).
 *
 * Connection lifecycle (PR2, wootty "Transport Lifecycle Contract", research §4):
 *   1. Client opens the socket and sends `attach{lastSeq}` as its first frame.
 *   2. The bridge replies `ready{cols,rows,alive,lastSeq,truncated}` and replays
 *      ONLY the scrollback chunks with `seq > attach.lastSeq` (delta replay). If
 *      that range was already evicted, `truncated=true` is set and the FULL
 *      current buffer is replayed (the client resets its terminal first).
 *   3. Live output then streams as `output` frames.
 *
 * Heartbeat: the client sends `ping` every 12s and the bridge answers `pong`. If
 * no client frame (ping or otherwise) arrives within Heartbeat.timeoutMs, the
 * bridge closes the socket with CloseCode.PongTimeout (4103) so the client's
 * reconnect/backoff kicks in. This survives half-open TCP that a `close` event
 * would never surface.
 *
 * Inbound `input` is fed char-by-char to the PTY (the bracketed-paste fix lives
 * in PtySession.write); inbound `resize` is forwarded with an alive-guard (fix
 * lives in PtySession.resize). On PTY exit, broadcast `exit` to every client.
 *
 * A client that never sends `attach` (e.g. a raw probe) is greeted after a short
 * grace timeout with a full replay, so the terminal still works without the
 * handshake.
 */

import { createServer, type RequestListener, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { PtySession } from "./pty-session.js";
import { createStaticHandler } from "./static-server.js";
import {
  parseClientMessage,
  serializeServerMessage,
  CloseCode,
  Heartbeat,
  type ServerMessage,
} from "./protocol.js";

export interface TerminalServerOptions {
  readonly port: number;
  /** Bind address — loopback only; tailscale serve fronts it with HTTPS in PR3. */
  readonly host?: string;
  /**
   * Directory of the built PWA (web/dist) to serve over HTTP on the SAME port as
   * the ws. Omit to skip static serving (ws-only); tests pass undefined.
   */
  readonly webDist?: string;
  /** Optional sink for the "dist missing" warning (defaults to console.warn). */
  readonly warn?: (message: string) => void;
}

/** Wait this long for the client's `attach` frame before greeting with a full replay. */
const ATTACH_GRACE_MS = 1_000;

export class TerminalServer {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly session: PtySession;
  private readonly host: string;
  private readonly port_: number;
  private detachExit: (() => void) | null = null;

  constructor(session: PtySession, options: TerminalServerOptions) {
    this.session = session;
    this.host = options.host ?? "127.0.0.1";
    this.port_ = options.port;

    // One http.Server hosts both the PWA (HTTP GET) and the ws (Upgrade). They
    // share the port and are told apart by the `Upgrade` header, so a single
    // `tailscale serve --bg <port>` fronts the whole origin (PR3). When no
    // webDist is given (tests), static GETs just 404 — the ws path is unaffected.
    const staticHandler: RequestListener = options.webDist
      ? createStaticHandler({ webDist: options.webDist, warn: options.warn })
      : (_req, res) => {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not Found");
        };
    this.http = createServer(staticHandler);

    // Attach the ws server to the http.Server (no own port) so Upgrade requests
    // share the listening socket. `noServer: false` + `server` is the standard
    // `ws` pattern; the connection lifecycle below is unchanged from PR2.
    this.wss = new WebSocketServer({ server: this.http });

    this.wss.on("connection", (socket) => this.handleConnection(socket));

    // Broadcast PTY exit to all clients. Kept so we can detach on close().
    this.detachExit = this.session.onExit((exit) => {
      this.broadcast({ type: "exit", code: exit.code, signal: exit.signal });
    });

    this.http.listen(this.port_, this.host);
  }

  /** Resolves once the server is actually listening. */
  whenListening(): Promise<void> {
    if (this.http.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.http.once("listening", resolve);
      this.http.once("error", reject);
    });
  }

  /** The bound port (useful when port 0 was requested for tests). */
  get port(): number {
    const addr = this.http.address();
    return typeof addr === "object" && addr !== null ? addr.port : this.port_;
  }

  private handleConnection(socket: WebSocket): void {
    // Per-connection state.
    let attached = false;
    let detachOutput: (() => void) | null = null;

    // --- Heartbeat watchdog -------------------------------------------------
    // Reset on every inbound frame; if it ever fires, the link is dead.
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    const armHeartbeat = (): void => {
      if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        // No client frame within the window — assume a dead/half-open link.
        socket.close(CloseCode.PongTimeout, "pong timeout");
      }, Heartbeat.timeoutMs);
    };

    // --- attach handshake ---------------------------------------------------
    // Greet + (delta) replay + start live streaming. Idempotent: only the first
    // call (attach frame OR grace-timeout fallback) wins.
    const attach = (lastSeq: number): void => {
      if (attached) return;
      attached = true;
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }

      const delta = this.session.since(lastSeq);

      // 1. Greet with current geometry + replay cursor + truncation flag.
      send(socket, {
        type: "ready",
        cols: this.session.cols,
        rows: this.session.rows,
        lastSeq: this.session.lastSeq,
        alive: this.session.alive,
        truncated: delta.truncated,
      });

      // 2. Replay the (delta or, when truncated, full) buffered output. The
      //    client resets its terminal on `truncated` before writing these.
      for (const chunk of delta.chunks) {
        send(socket, { type: "output", seq: chunk.seq, data: chunk.data });
      }

      // 3. If the PTY already exited, tell this client right away.
      const exit = this.session.exit;
      if (exit) {
        send(socket, { type: "exit", code: exit.code, signal: exit.signal });
      }

      // 4. Stream live output until the client disconnects. There is no seq gap
      //    between the last replayed chunk and the first live chunk: both come
      //    from the same monotonic scrollback counter, and any chunk pushed
      //    between `since()` and here has a seq strictly greater than every
      //    replayed seq, so the client's "seq must advance" guard de-dupes
      //    cleanly without dropping or repeating frames.
      detachOutput = this.session.onOutput((chunk) => {
        send(socket, { type: "output", seq: chunk.seq, data: chunk.data });
      });
    };

    // Fallback: a client that never sends `attach` still gets a full replay.
    let graceTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      graceTimer = null;
      attach(0);
    }, ATTACH_GRACE_MS);

    armHeartbeat();

    socket.on("message", (raw, isBinary) => {
      // The xterm.js client sends JSON text frames only.
      if (isBinary) return;
      // Any inbound frame is proof of life — reset the watchdog.
      armHeartbeat();

      const msg = parseClientMessage(raw.toString("utf8"));
      if (!msg) return;
      switch (msg.type) {
        case "attach":
          attach(msg.lastSeq);
          break;
        case "ping":
          send(socket, { type: "pong" });
          break;
        case "input":
          this.session.write(msg.data);
          break;
        case "resize":
          this.session.resize(msg.cols, msg.rows);
          break;
      }
    });

    const cleanup = (): void => {
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      if (heartbeatTimer !== null) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      detachOutput?.();
      detachOutput = null;
    };

    socket.on("close", cleanup);
    socket.on("error", cleanup);
  }

  private broadcast(msg: ServerMessage): void {
    const payload = serializeServerMessage(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  /** Close the server and all client sockets. Does not kill the PTY. */
  async close(): Promise<void> {
    this.detachExit?.();
    this.detachExit = null;
    for (const client of this.wss.clients) client.terminate();
    // Close the ws server first (it does NOT close the http.Server it's attached
    // to), then the http.Server, so the listening socket is actually released.
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      this.http.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(serializeServerMessage(msg));
  }
}
