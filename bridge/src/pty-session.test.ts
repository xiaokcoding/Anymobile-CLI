/**
 * PtySession smoke tests — exercise the PR1 core without depending on a real
 * `claude` binary. We spawn `node` itself in a PTY (cross-platform) running tiny
 * inline scripts, and assert the three load-bearing behaviours plus scrollback.
 *
 * Run via tsx: `pnpm --filter @mobile-ssh/bridge test`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PtySession, type PtyExit } from "./pty-session.js";
import { ScrollbackBuffer } from "./scrollback.js";

const NODE = process.execPath;

/** Build a session that runs an inline node script in a PTY. */
function spawnNode(script: string, charDelayMs = 0): PtySession {
  return new PtySession({
    file: NODE,
    args: ["-e", script],
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    scrollbackBytes: 64 * 1024,
    charDelayMs,
  });
}

function waitForExit(session: PtySession, timeoutMs = 10_000): Promise<PtyExit> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("PTY did not exit in time")), timeoutMs);
    session.onExit((exit) => {
      clearTimeout(timer);
      resolve(exit);
    });
  });
}

test("output streams from the PTY to onOutput listeners", async () => {
  const session = spawnNode("process.stdout.write('HELLO_FROM_PTY'); process.exit(0);");
  let captured = "";
  session.onOutput((chunk) => {
    captured += chunk.data;
  });
  await waitForExit(session);
  assert.ok(captured.includes("HELLO_FROM_PTY"), `expected greeting in output, got: ${JSON.stringify(captured)}`);
});

test("write() feeds input char-by-char without throwing while alive", async () => {
  // A script that reads one line of stdin and echoes it back, then exits.
  const script = [
    "process.stdin.setEncoding('utf8');",
    "let buf='';",
    "process.stdin.on('data',d=>{buf+=d;if(buf.includes('\\r')||buf.includes('\\n')){process.stdout.write('GOT:'+buf.replace(/[\\r\\n]/g,''));process.exit(0);}});",
  ].join("");
  const session = spawnNode(script, 2);
  let captured = "";
  session.onOutput((chunk) => {
    captured += chunk.data;
  });
  // Char-by-char write must not throw; the trailing \r must arrive as a real Enter.
  assert.doesNotThrow(() => session.write("abc\r"));
  await waitForExit(session);
  assert.ok(captured.includes("GOT:abc"), `expected echoed input, got: ${JSON.stringify(captured)}`);
});

test("resize is normal while alive and safely skipped after exit (no crash, #827)", async () => {
  const session = spawnNode("process.stdout.write('x'); process.exit(0);");
  // While alive: resize should apply.
  assert.doesNotThrow(() => session.resize(120, 40));
  assert.equal(session.cols, 120);
  assert.equal(session.rows, 40);

  await waitForExit(session);
  assert.equal(session.alive, false);

  // After exit: resize must be a silent no-op, NOT a process-killing native throw.
  assert.doesNotThrow(() => session.resize(200, 50));
  // Geometry stays at the last live value.
  assert.equal(session.cols, 120);
  assert.equal(session.rows, 40);
});

test("write() after exit is a no-op and does not throw", async () => {
  const session = spawnNode("process.exit(0);");
  await waitForExit(session);
  assert.doesNotThrow(() => session.write("ignored\r"));
});

test("scrollback replay returns chunks oldest-first with monotonic seq", async () => {
  const session = spawnNode(
    "process.stdout.write('A');process.stdout.write('B');process.stdout.write('C');process.exit(0);",
  );
  await waitForExit(session);
  const snap = session.snapshot();
  assert.ok(snap.length >= 1, "expected at least one buffered chunk");
  // seq is strictly increasing in snapshot order.
  for (let i = 1; i < snap.length; i++) {
    assert.ok(snap[i]!.seq > snap[i - 1]!.seq, "seq must be strictly increasing");
  }
  const joined = snap.map((c) => c.data).join("");
  assert.ok(joined.includes("A") && joined.includes("B") && joined.includes("C"));
  assert.equal(session.lastSeq, snap[snap.length - 1]!.seq);
});

test("ScrollbackBuffer evicts oldest chunks past the byte cap but keeps the newest", () => {
  const buf = new ScrollbackBuffer(10); // 10-byte cap
  buf.push("aaaaa"); // 5 bytes  -> [aaaaa]
  buf.push("bbbbb"); // 10 bytes -> [aaaaa, bbbbb]
  buf.push("ccccc"); // 15 -> evict aaaaa -> [bbbbb, ccccc] = 10 bytes
  const snap = buf.snapshot();
  assert.deepEqual(
    snap.map((c) => c.data),
    ["bbbbb", "ccccc"],
  );
  assert.equal(buf.size, 10);
  // seq keeps counting even across eviction.
  assert.equal(buf.lastSeq, 3);
  assert.equal(snap[0]!.seq, 2);
});

test("ScrollbackBuffer keeps a single oversized chunk rather than dropping everything", () => {
  const buf = new ScrollbackBuffer(4);
  const chunk = buf.push("way-too-big-for-the-cap");
  assert.equal(buf.length, 1);
  assert.equal(buf.snapshot()[0]!.data, chunk.data);
});

test("since(0) returns the full buffer, never truncated (fresh client)", () => {
  const buf = new ScrollbackBuffer(1024);
  buf.push("A");
  buf.push("B");
  const delta = buf.since(0);
  assert.equal(delta.truncated, false);
  assert.deepEqual(
    delta.chunks.map((c) => c.data),
    ["A", "B"],
  );
});

test("since(lastSeq) returns only newer chunks for an up-to-date-ish client", () => {
  const buf = new ScrollbackBuffer(1024);
  buf.push("A"); // seq 1
  buf.push("B"); // seq 2
  buf.push("C"); // seq 3
  const delta = buf.since(2); // client already has through seq 2
  assert.equal(delta.truncated, false);
  assert.deepEqual(
    delta.chunks.map((c) => c.data),
    ["C"],
  );
  assert.equal(delta.chunks[0]!.seq, 3);
});

test("since(currentSeq) returns nothing when the client is fully caught up", () => {
  const buf = new ScrollbackBuffer(1024);
  buf.push("A");
  buf.push("B");
  const delta = buf.since(2);
  assert.equal(delta.truncated, false);
  assert.equal(delta.chunks.length, 0);
});

test("since() ahead of the buffer (e.g. server restart reset seq) returns nothing, not truncated", () => {
  const buf = new ScrollbackBuffer(1024);
  buf.push("A"); // seq 1
  // Client claims seq 99 (stale from a previous bridge run); we have far less.
  const delta = buf.since(99);
  assert.equal(delta.truncated, false);
  assert.equal(delta.chunks.length, 0);
});

test("since() flags truncated when the requested range was already evicted (gap)", () => {
  const buf = new ScrollbackBuffer(10); // 10-byte cap
  buf.push("aaaaa"); // seq 1
  buf.push("bbbbb"); // seq 2
  buf.push("ccccc"); // seq 3 -> evicts seq 1; buffer now [bbbbb(2), ccccc(3)]
  // Client last saw seq 1; the next chunk it needs (seq 2) is still present here,
  // so NOT truncated.
  assert.equal(buf.since(1).truncated, false);

  buf.push("ddddd"); // seq 4 -> evicts seq 2; buffer now [ccccc(3), ddddd(4)]
  // Client last saw seq 1; the next chunk it needs (seq 2) is GONE -> gap.
  const delta = buf.since(1);
  assert.equal(delta.truncated, true);
  // On truncation the caller replays the full current buffer.
  assert.deepEqual(
    delta.chunks.map((c) => c.data),
    ["ccccc", "ddddd"],
  );
});

test("firstSeq tracks the oldest retained chunk across eviction", () => {
  const buf = new ScrollbackBuffer(10);
  assert.equal(buf.firstSeq, 0); // empty
  buf.push("aaaaa"); // seq 1
  assert.equal(buf.firstSeq, 1);
  buf.push("bbbbb"); // seq 2
  buf.push("ccccc"); // seq 3 -> evict seq 1
  assert.equal(buf.firstSeq, 2);
  assert.equal(buf.lastSeq, 3);
});

test("snapshot→live boundary has no seq gap or repeat (delta replay then push)", () => {
  // Models the ws-server attach path: since(lastSeq) for replay, then live pushes.
  // The client de-dupes by "seq must strictly advance"; assert that contract holds.
  const buf = new ScrollbackBuffer(1024);
  buf.push("one"); // seq 1
  buf.push("two"); // seq 2 — client already rendered through here
  const clientLastSeq = 2;

  const replay = buf.since(clientLastSeq).chunks; // what attach replays
  const live = buf.push("three"); // live chunk pushed right after attach

  // Simulate the client's seq-guarded render.
  let rendered = clientLastSeq;
  const out: string[] = [];
  for (const chunk of [...replay, live]) {
    if (chunk.seq > rendered) {
      out.push(chunk.data);
      rendered = chunk.seq;
    }
  }
  // No repeat of already-seen seqs, no gap: exactly the new chunk lands.
  assert.deepEqual(out, ["three"]);
  assert.equal(rendered, 3);
});
