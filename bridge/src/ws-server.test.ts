/**
 * TerminalServer reconnect/replay integration tests (PR2).
 *
 * These drive the real ws-server over a real `ws` WebSocket against a fake
 * "PTY" (a minimal stand-in that emits chunks on demand), so we exercise the
 * actual attach→ready→delta-replay→live-stream path and the lastSeq resume
 * without spawning a process. Heartbeat timing is covered by the pure-logic
 * tests; here we assert the wire behaviour that backs acceptance criterion ③
 * (background/reconnect → no lost output).
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { ScrollbackBuffer, type OutputChunk, type ScrollbackDelta } from "./scrollback.js";
import { TerminalServer } from "./ws-server.js";
import type { ServerMessage } from "./protocol.js";
import type { PtySession } from "./pty-session.js";

/** Parse a server→client frame for assertions (the test acts as the client). */
function parseFrame(raw: string): ServerMessage | null {
  try {
    return JSON.parse(raw) as ServerMessage;
  } catch {
    return null;
  }
}

/**
 * Minimal PtySession stand-in: a scrollback ring plus output listeners. Only the
 * members TerminalServer touches are implemented; cast to PtySession for the API.
 */
class FakeSession {
  private readonly buf = new ScrollbackBuffer(1024 * 1024);
  private readonly listeners = new Set<(c: OutputChunk) => void>();
  cols = 80;
  rows = 24;
  alive = true;
  exit: { code: number; signal: number | undefined } | null = null;

  get lastSeq(): number {
    return this.buf.lastSeq;
  }
  get firstSeq(): number {
    return this.buf.firstSeq;
  }
  snapshot(): OutputChunk[] {
    return this.buf.snapshot();
  }
  since(seq: number): ScrollbackDelta {
    return this.buf.since(seq);
  }
  onOutput(listener: (c: OutputChunk) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onExit(): () => void {
    return () => undefined;
  }
  write(): void {
    /* not exercised here */
  }
  resize(): void {
    /* not exercised here */
  }
  /** Test helper: push output and notify live listeners (like a real PTY onData). */
  emit(data: string): OutputChunk {
    const chunk = this.buf.push(data);
    for (const l of this.listeners) l(chunk);
    return chunk;
  }
}

function startServer(session: FakeSession): Promise<TerminalServer> {
  const server = new TerminalServer(session as unknown as PtySession, { port: 0 });
  return server.whenListening().then(() => server);
}

/**
 * Build a hermetic web/dist fixture so the static tests don't depend on the web
 * package having been built. Returns the dist path; the caller deletes it.
 */
function makeDistFixture(): string {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-ssh-dist-"));
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>shell</title>");
  fs.writeFileSync(path.join(dist, "sw.js"), "/* sw */ self.addEventListener('install', () => {});");
  fs.writeFileSync(path.join(dist, "manifest.webmanifest"), '{"name":"x"}');
  fs.mkdirSync(path.join(dist, "assets"));
  fs.writeFileSync(path.join(dist, "assets", "index-abc123.js"), "export const x = 1;");
  return dist;
}

/** Start a server that ALSO serves a freshly-built dist fixture. */
function startServerWithDist(session: FakeSession, webDist: string): Promise<TerminalServer> {
  const server = new TerminalServer(session as unknown as PtySession, {
    port: 0,
    webDist,
    warn: () => undefined, // silence the missing-dist warning path in tests
  });
  return server.whenListening().then(() => server);
}

/**
 * GET a path with keep-alive disabled. Without `Connection: close`, Node's fetch
 * (undici) holds an idle pooled socket that delays `server.close()` by the HTTP
 * keep-alive timeout, ballooning the test runtime for no benefit.
 */
function getNoKeepAlive(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { Connection: "close", ...init.headers } });
}

/** Open a socket, send `attach{lastSeq}`, and collect frames until `collectMs` of quiet. */
function attachAndCollect(
  port: number,
  lastSeq: number,
  options: { collectMs?: number } = {},
): Promise<{ socket: WebSocket; frames: (ServerMessage | null)[] }> {
  const collectMs = options.collectMs ?? 300;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const frames: (ServerMessage | null)[] = [];
    let idle: ReturnType<typeof setTimeout> | null = null;
    const arm = (): void => {
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => resolve({ socket, frames }), collectMs);
    };
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "attach", lastSeq }));
      arm();
    });
    socket.on("message", (raw) => {
      frames.push(parseFrame(raw.toString("utf8")));
      arm();
    });
    socket.on("error", reject);
  });
}

test("attach with lastSeq=0 replays the full buffer, ready is not truncated", async () => {
  const session = new FakeSession();
  session.emit("AAA"); // seq 1
  session.emit("BBB"); // seq 2
  const server = await startServer(session);

  const { socket, frames } = await attachAndCollect(server.port, 0);
  socket.close();
  await server.close();

  const ready = frames.find((f) => f?.type === "ready");
  assert.ok(ready && ready.type === "ready");
  assert.equal(ready.truncated, false);
  assert.equal(ready.lastSeq, 2);

  const outputs = frames.filter((f) => f?.type === "output");
  assert.deepEqual(
    outputs.map((f) => (f?.type === "output" ? f.data : "")),
    ["AAA", "BBB"],
  );
});

test("attach with a lastSeq replays ONLY newer chunks (delta resume)", async () => {
  const session = new FakeSession();
  session.emit("AAA"); // seq 1
  session.emit("BBB"); // seq 2
  session.emit("CCC"); // seq 3
  const server = await startServer(session);

  // Client already rendered through seq 2 — should only get seq 3.
  const { socket, frames } = await attachAndCollect(server.port, 2);
  socket.close();
  await server.close();

  const outputs = frames.filter((f) => f?.type === "output");
  assert.deepEqual(
    outputs.map((f) => (f?.type === "output" ? { seq: f.seq, data: f.data } : null)),
    [{ seq: 3, data: "CCC" }],
  );
});

test("live output after attach continues the seq with no gap or repeat", async () => {
  const session = new FakeSession();
  session.emit("AAA"); // seq 1
  const server = await startServer(session);

  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const outputs: OutputChunk[] = [];
  let readySeen = false;
  await new Promise<void>((resolve, reject) => {
    socket.on("open", () => socket.send(JSON.stringify({ type: "attach", lastSeq: 0 })));
    socket.on("error", reject);
    socket.on("message", (raw) => {
      const msg = parseFrame(raw.toString("utf8"));
      if (!msg) return;
      if (msg.type === "ready") {
        readySeen = true;
        // Emit a live chunk only after the replay handshake.
        session.emit("BBB"); // seq 2
      } else if (msg.type === "output") {
        outputs.push({ seq: msg.seq, data: msg.data });
        if (outputs.length === 2) resolve();
      }
    });
  });
  socket.close();
  await server.close();

  assert.ok(readySeen);
  assert.deepEqual(outputs, [
    { seq: 1, data: "AAA" },
    { seq: 2, data: "BBB" },
  ]);
});

test("reconnect with the last seen seq resumes exactly the missed output", async () => {
  const session = new FakeSession();
  session.emit("AAA"); // seq 1
  const server = await startServer(session);

  // First connection: get through seq 1, then "go to background" (close).
  const first = await attachAndCollect(server.port, 0);
  const firstOutputs = first.frames.filter((f) => f?.type === "output");
  assert.deepEqual(
    firstOutputs.map((f) => (f?.type === "output" ? f.seq : 0)),
    [1],
  );
  first.socket.close();
  await new Promise((r) => setTimeout(r, 50));

  // While "backgrounded", the PTY keeps producing output.
  session.emit("BBB"); // seq 2
  session.emit("CCC"); // seq 3

  // Reconnect resuming from seq 1 — must get exactly seq 2 and 3.
  const second = await attachAndCollect(server.port, 1);
  second.socket.close();
  await server.close();

  const secondOutputs = second.frames.filter((f) => f?.type === "output");
  assert.deepEqual(
    secondOutputs.map((f) => (f?.type === "output" ? { seq: f.seq, data: f.data } : null)),
    [
      { seq: 2, data: "BBB" },
      { seq: 3, data: "CCC" },
    ],
  );
  const ready = second.frames.find((f) => f?.type === "ready");
  assert.ok(ready && ready.type === "ready" && ready.truncated === false);
});

test("bridge answers ping with pong", async () => {
  const session = new FakeSession();
  const server = await startServer(session);

  const gotPong = await new Promise<boolean>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "attach", lastSeq: 0 }));
      socket.send(JSON.stringify({ type: "ping" }));
    });
    socket.on("error", reject);
    socket.on("message", (raw) => {
      const msg = parseFrame(raw.toString("utf8"));
      if (msg?.type === "pong") {
        socket.close();
        resolve(true);
      }
    });
    setTimeout(() => resolve(false), 1_000);
  });
  await server.close();
  assert.equal(gotPong, true);
});

// --- PR3: static PWA served on the SAME port as the ws ----------------------

test("GET / serves the app shell as text/html", async () => {
  const dist = makeDistFixture();
  const session = new FakeSession();
  const server = await startServerWithDist(session, dist);

  const res = await getNoKeepAlive(`http://127.0.0.1:${server.port}/`);
  const body = await res.text();
  await server.close();
  fs.rmSync(dist, { recursive: true, force: true });

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(body, /<title>shell<\/title>/);
});

test("a deep navigation route falls back to the app shell (SPA)", async () => {
  const dist = makeDistFixture();
  const session = new FakeSession();
  const server = await startServerWithDist(session, dist);

  // No such file, but an HTML-accepting request → index.html (200, not 404).
  const res = await getNoKeepAlive(`http://127.0.0.1:${server.port}/some/route`, {
    headers: { Accept: "text/html" },
  });
  const body = await res.text();
  await server.close();
  fs.rmSync(dist, { recursive: true, force: true });

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(body, /shell/);
});

test("GET /sw.js is text/javascript with Cache-Control: no-cache", async () => {
  const dist = makeDistFixture();
  const session = new FakeSession();
  const server = await startServerWithDist(session, dist);

  const res = await getNoKeepAlive(`http://127.0.0.1:${server.port}/sw.js`);
  await res.text();
  await server.close();
  fs.rmSync(dist, { recursive: true, force: true });

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/javascript/);
  assert.equal(res.headers.get("cache-control"), "no-cache");
});

test("hashed assets under /assets/ are served with long immutable caching", async () => {
  const dist = makeDistFixture();
  const session = new FakeSession();
  const server = await startServerWithDist(session, dist);

  const res = await getNoKeepAlive(`http://127.0.0.1:${server.port}/assets/index-abc123.js`);
  await res.text();
  await server.close();
  fs.rmSync(dist, { recursive: true, force: true });

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/javascript/);
  assert.match(res.headers.get("cache-control") ?? "", /immutable/);
});

test("path traversal is rejected with 404 (cannot escape the dist root)", async () => {
  const dist = makeDistFixture();
  const session = new FakeSession();
  const server = await startServerWithDist(session, dist);

  // Encoded traversal aimed at a bridge source file outside web/dist. fetch()
  // normalises raw "../", so we hit the server with a percent-encoded attempt.
  const res = await getNoKeepAlive(`http://127.0.0.1:${server.port}/%2e%2e/config.ts`);
  await res.text();
  await server.close();
  fs.rmSync(dist, { recursive: true, force: true });

  assert.equal(res.status, 404);
});

test("non-GET/HEAD methods are rejected with 405", async () => {
  const dist = makeDistFixture();
  const session = new FakeSession();
  const server = await startServerWithDist(session, dist);

  const res = await getNoKeepAlive(`http://127.0.0.1:${server.port}/`, { method: "POST" });
  await res.text();
  await server.close();
  fs.rmSync(dist, { recursive: true, force: true });

  assert.equal(res.status, 405);
  assert.match(res.headers.get("allow") ?? "", /GET/);
});

test("GET returns 503 with a build hint when web/dist is missing", async () => {
  const missing = path.join(os.tmpdir(), `mobile-ssh-absent-${Date.now()}`);
  const session = new FakeSession();
  const server = await startServerWithDist(session, missing);

  const res = await getNoKeepAlive(`http://127.0.0.1:${server.port}/`);
  const body = await res.text();
  await server.close();

  assert.equal(res.status, 503);
  assert.match(body, /pnpm --filter @mobile-ssh\/web build/);
});

test("ws Upgrade still completes attach→ready→output on the SAME server that serves static", async () => {
  const dist = makeDistFixture();
  const session = new FakeSession();
  session.emit("AAA"); // seq 1
  const server = await startServerWithDist(session, dist);

  // Sanity: static GET works on this port...
  const httpRes = await getNoKeepAlive(`http://127.0.0.1:${server.port}/`);
  await httpRes.text();
  assert.equal(httpRes.status, 200);

  // ...and a ws Upgrade on the very same port runs the full handshake.
  const { socket, frames } = await attachAndCollect(server.port, 0);
  socket.close();
  await server.close();
  fs.rmSync(dist, { recursive: true, force: true });

  const ready = frames.find((f) => f?.type === "ready");
  assert.ok(ready && ready.type === "ready");
  const outputs = frames.filter((f) => f?.type === "output");
  assert.deepEqual(
    outputs.map((f) => (f?.type === "output" ? f.data : "")),
    ["AAA"],
  );
});
