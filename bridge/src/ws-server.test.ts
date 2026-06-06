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
import { TerminalServer, type ApprovalIntegration } from "./ws-server.js";
import type { ServerMessage } from "./protocol.js";
import type { PtySession } from "./pty-session.js";
import { ApprovalRegistry } from "./approval.js";
import { NtfyClient } from "./ntfy.js";

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

// --- PR4: auth + cc hooks + approval round-trip -----------------------------

const TEST_TOKEN = "test-token-123";

/** A captured ntfy push (we never hit the network in tests). */
interface CapturedPush {
  url: string;
  body: Record<string, unknown>;
}

/** Build a fetch double that records ntfy pushes and returns 200. */
function recordingFetch(): { fetch: typeof fetch; pushes: CapturedPush[] } {
  const pushes: CapturedPush[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    pushes.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fn, pushes };
}

interface ApprovalServerSetup {
  server: TerminalServer;
  approvals: ApprovalRegistry;
  pushes: CapturedPush[];
}

/** Start a server with the PR4 approval stack wired (token auth + hooks + ntfy). */
async function startApprovalServer(
  session: FakeSession,
  opts: { timeoutMs?: number; timeoutDecision?: "allow" | "deny" | "ask"; topic?: string | undefined; baseUrl?: string } = {},
): Promise<ApprovalServerSetup> {
  const approvals = new ApprovalRegistry({
    timeoutMs: opts.timeoutMs ?? 10_000,
    timeoutDecision: opts.timeoutDecision ?? "deny",
  });
  const { fetch, pushes } = recordingFetch();
  const ntfy = new NtfyClient({
    server: "https://ntfy.test",
    topic: "topic" in opts ? opts.topic : "test-topic",
    fetchImpl: fetch,
    warn: () => undefined,
  });
  const approval: ApprovalIntegration = {
    token: TEST_TOKEN,
    approvals,
    ntfy,
    approvalBaseUrl: opts.baseUrl ?? "https://host.ts.net",
  };
  const server = new TerminalServer(session as unknown as PtySession, {
    port: 0,
    approval,
    warn: () => undefined,
  });
  await server.whenListening();
  return { server, approvals, pushes };
}

/** POST JSON to a path with a Bearer token (omit to test the 401 path). */
function postJson(
  url: string,
  payload: unknown,
  opts: { token?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Connection: "close",
  };
  if (opts.token !== undefined) headers.Authorization = `Bearer ${opts.token}`;
  return fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
}

/** Open an authed ws and resolve once a frame matching `pred` arrives (or time out). */
function waitForFrame(
  port: number,
  token: string,
  pred: (m: ServerMessage) => boolean,
  onOpen?: (socket: WebSocket) => void,
  timeoutMs = 2_000,
): Promise<{ socket: WebSocket; frame: ServerMessage }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("frame not seen in time"));
    }, timeoutMs);
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "attach", lastSeq: 0 }));
      onOpen?.(socket);
    });
    socket.on("error", reject);
    socket.on("message", (raw) => {
      const m = parseFrame(raw.toString("utf8"));
      if (m && pred(m)) {
        clearTimeout(timer);
        resolve({ socket, frame: m });
      }
    });
  });
}

test("ws Upgrade is rejected without a matching ?token=", async () => {
  const session = new FakeSession();
  const { server } = await startApprovalServer(session);

  const rejected = await new Promise<boolean>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`); // no token
    socket.on("open", () => {
      socket.close();
      resolve(false); // should NOT open
    });
    socket.on("error", () => resolve(true)); // handshake rejected → error
    setTimeout(() => resolve(false), 1_000);
  });
  await server.close();
  assert.equal(rejected, true);
});

test("ws Upgrade with the wrong token is rejected", async () => {
  const session = new FakeSession();
  const { server } = await startApprovalServer(session);

  const rejected = await new Promise<boolean>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/?token=wrong`);
    socket.on("open", () => {
      socket.close();
      resolve(false);
    });
    socket.on("error", () => resolve(true));
    setTimeout(() => resolve(false), 1_000);
  });
  await server.close();
  assert.equal(rejected, true);
});

test("ws Upgrade with the correct token connects and completes the handshake", async () => {
  const session = new FakeSession();
  session.emit("hi"); // seq 1
  const { server } = await startApprovalServer(session);

  const { socket, frame } = await waitForFrame(
    server.port,
    TEST_TOKEN,
    (m) => m.type === "ready",
  );
  socket.close();
  await server.close();
  assert.equal(frame.type, "ready");
});

test("POST /hooks/pre-tool-use without a Bearer token is 401", async () => {
  const session = new FakeSession();
  const { server } = await startApprovalServer(session);

  const res = await postJson(`http://127.0.0.1:${server.port}/hooks/pre-tool-use`, {
    tool_name: "Bash",
    tool_input: { command: "ls" },
  }); // no token
  await res.text();
  await server.close();
  assert.equal(res.status, 401);
});

test("POST /hooks/pre-tool-use with the wrong Bearer token is 401", async () => {
  const session = new FakeSession();
  const { server } = await startApprovalServer(session);

  const res = await postJson(
    `http://127.0.0.1:${server.port}/hooks/pre-tool-use`,
    { tool_name: "Bash", tool_input: {} },
    { token: "nope" },
  );
  await res.text();
  await server.close();
  assert.equal(res.status, 401);
});

test("pre-tool-use → resolved via a ws approval_decision → response carries permissionDecision", async () => {
  const session = new FakeSession();
  const { server } = await startApprovalServer(session);

  // A connected PWA waits for the approval_request, then taps "allow".
  const cardSeen = waitForFrame(server.port, TEST_TOKEN, (m) => m.type === "approval_request");

  // cc's hook POSTs and blocks on the response.
  const hookPromise = postJson(
    `http://127.0.0.1:${server.port}/hooks/pre-tool-use`,
    { tool_name: "Bash", tool_input: { command: "rm -rf build" } },
    { token: TEST_TOKEN },
  );

  const { socket, frame } = await cardSeen;
  assert.ok(frame.type === "approval_request");
  assert.equal(frame.toolName, "Bash");
  assert.match(frame.toolInput, /rm -rf build/);

  // PWA approves over the (already token-authed) ws.
  socket.send(JSON.stringify({ type: "approval_decision", id: frame.id, decision: "allow" }));

  const res = await hookPromise;
  const json = (await res.json()) as {
    hookSpecificOutput?: { permissionDecision?: string; hookEventName?: string };
  };
  socket.close();
  await server.close();

  assert.equal(res.status, 200);
  assert.equal(json.hookSpecificOutput?.hookEventName, "PreToolUse");
  assert.equal(json.hookSpecificOutput?.permissionDecision, "allow");
});

test("pre-tool-use → resolved via the ntfy http-action callback (nonce) → deny", async () => {
  const session = new FakeSession();
  const { server, approvals } = await startApprovalServer(session);

  const hookPromise = postJson(
    `http://127.0.0.1:${server.port}/hooks/pre-tool-use`,
    { tool_name: "Bash", tool_input: { command: "ls" } },
    { token: TEST_TOKEN },
  );

  // Grab the pending approval's id + nonce directly from the registry (the ntfy
  // button would carry these in its URL).
  const pending = await waitForPending(approvals);

  // Wrong nonce is rejected and does NOT resolve.
  const bad = await fetch(
    `http://127.0.0.1:${server.port}/approvals/${pending.id}?decision=allow&nonce=wrong`,
    { method: "POST", headers: { Connection: "close" } },
  );
  await bad.text();
  assert.equal(bad.status, 401);
  assert.equal(approvals.has(pending.id), true); // still pending

  // Correct nonce resolves it (deny).
  const ok = await fetch(
    `http://127.0.0.1:${server.port}/approvals/${pending.id}?decision=deny&nonce=${pending.nonce}`,
    { method: "POST", headers: { Connection: "close" } },
  );
  await ok.text();
  assert.equal(ok.status, 200);

  const res = await hookPromise;
  const json = (await res.json()) as { hookSpecificOutput?: { permissionDecision?: string } };
  await server.close();

  assert.equal(json.hookSpecificOutput?.permissionDecision, "deny");
});

test("a second ntfy callback for an already-resolved approval is an idempotent 200", async () => {
  const session = new FakeSession();
  const { server, approvals } = await startApprovalServer(session);

  const hookPromise = postJson(
    `http://127.0.0.1:${server.port}/hooks/pre-tool-use`,
    { tool_name: "Bash", tool_input: {} },
    { token: TEST_TOKEN },
  );
  const pending = await waitForPending(approvals);

  const first = await fetch(
    `http://127.0.0.1:${server.port}/approvals/${pending.id}?decision=allow&nonce=${pending.nonce}`,
    { method: "POST", headers: { Connection: "close" } },
  );
  await first.text();
  const second = await fetch(
    `http://127.0.0.1:${server.port}/approvals/${pending.id}?decision=allow&nonce=${pending.nonce}`,
    { method: "POST", headers: { Connection: "close" } },
  );
  const secondBody = (await second.json()) as { ok?: boolean; alreadyResolved?: boolean };

  await hookPromise;
  await server.close();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(secondBody.alreadyResolved, true);
});

test("pre-tool-use times out → fail-closed deny, returned before the cc hook timeout", async () => {
  const session = new FakeSession();
  // 80ms bridge timeout stands in for the real 280s (kept < cc's 300s hook timeout).
  const { server } = await startApprovalServer(session, { timeoutMs: 80, timeoutDecision: "deny" });

  const started = Date.now();
  const res = await postJson(
    `http://127.0.0.1:${server.port}/hooks/pre-tool-use`,
    { tool_name: "Bash", tool_input: { command: "rm -rf /" } },
    { token: TEST_TOKEN },
  );
  const json = (await res.json()) as { hookSpecificOutput?: { permissionDecision?: string } };
  const elapsed = Date.now() - started;
  await server.close();

  assert.equal(json.hookSpecificOutput?.permissionDecision, "deny");
  // It actually waited for the timeout (didn't answer instantly) but returned.
  assert.ok(elapsed >= 60, `expected to wait for the timeout, waited ${elapsed}ms`);
});

test("pre-tool-use push carries allow/deny buttons whose URLs use the nonce (not the token)", async () => {
  const session = new FakeSession();
  const { server, approvals, pushes } = await startApprovalServer(session);

  const hookPromise = postJson(
    `http://127.0.0.1:${server.port}/hooks/pre-tool-use`,
    { tool_name: "Bash", tool_input: { command: "ls" } },
    { token: TEST_TOKEN },
  );
  const pending = await waitForPending(approvals);

  // The ntfy push fires synchronously on create; give the microtask a tick.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pushes.length, 1);
  const actions = pushes[0]!.body.actions as Array<Record<string, unknown>>;
  assert.equal(actions.length, 2);
  for (const a of actions) {
    assert.match(String(a.url), new RegExp(`nonce=${pending.nonce}`));
    assert.doesNotMatch(String(a.url), new RegExp(TEST_TOKEN)); // token never in a ntfy URL
  }

  // Resolve so the blocked hook unblocks and the test can finish.
  approvals.resolve(pending.id, "allow");
  await hookPromise;
  await server.close();
});

test("POST /hooks/stop pushes a 'done' notice and returns 200 {} (never blocks cc)", async () => {
  const session = new FakeSession();
  const { server, pushes } = await startApprovalServer(session);

  const res = await postJson(
    `http://127.0.0.1:${server.port}/hooks/stop`,
    { last_assistant_message: "All tests passed." },
    { token: TEST_TOKEN },
  );
  const json = (await res.json()) as Record<string, unknown>;
  await new Promise((r) => setTimeout(r, 20));
  await server.close();

  assert.equal(res.status, 200);
  assert.deepEqual(json, {}); // NOT decision:block
  assert.equal(pushes.length, 1);
  assert.match(String(pushes[0]!.body.message), /All tests passed/);
});

test("a missing NTFY_TOPIC does not break the approval path (no push, still resolvable)", async () => {
  const session = new FakeSession();
  const { server, approvals } = await startApprovalServer(session, { topic: undefined });

  const hookPromise = postJson(
    `http://127.0.0.1:${server.port}/hooks/pre-tool-use`,
    { tool_name: "Bash", tool_input: {} },
    { token: TEST_TOKEN },
  );
  const pending = await waitForPending(approvals);
  approvals.resolve(pending.id, "allow");
  const res = await hookPromise;
  const json = (await res.json()) as { hookSpecificOutput?: { permissionDecision?: string } };
  await server.close();

  assert.equal(json.hookSpecificOutput?.permissionDecision, "allow");
});

test("routing priority: POST /hooks/* is handled by the API, not swallowed by static", async () => {
  // With a dist present, a POST to a hook path must still reach the API (401
  // without a token) rather than the static 405/404 path.
  const dist = makeDistFixture();
  const session = new FakeSession();
  const approvals = new ApprovalRegistry({ timeoutMs: 1_000, timeoutDecision: "deny" });
  const { fetch } = recordingFetch();
  const ntfy = new NtfyClient({ server: "https://ntfy.test", topic: "t", fetchImpl: fetch, warn: () => undefined });
  const server = new TerminalServer(session as unknown as PtySession, {
    port: 0,
    webDist: dist,
    approval: { token: TEST_TOKEN, approvals, ntfy, approvalBaseUrl: "https://host.ts.net" },
    warn: () => undefined,
  });
  await server.whenListening();

  // POST /hooks/stop with no token → API 401 (proves API ran, not static).
  const apiRes = await postJson(`http://127.0.0.1:${server.port}/hooks/stop`, {});
  await apiRes.text();
  assert.equal(apiRes.status, 401);

  // GET / still serves the app shell (static untouched).
  const getRes = await getNoKeepAlive(`http://127.0.0.1:${server.port}/`);
  const body = await getRes.text();
  assert.equal(getRes.status, 200);
  assert.match(body, /shell/);

  await server.close();
  fs.rmSync(dist, { recursive: true, force: true });
});

/** Poll the registry until a pending approval appears, then return its id+nonce. */
async function waitForPending(
  approvals: ApprovalRegistry,
): Promise<{ id: string; nonce: string }> {
  return new Promise((resolve, reject) => {
    const off = approvals.onCreated((a) => {
      off();
      resolve({ id: a.id, nonce: a.nonce });
    });
    setTimeout(() => {
      off();
      reject(new Error("no pending approval appeared"));
    }, 2_000);
  });
}

