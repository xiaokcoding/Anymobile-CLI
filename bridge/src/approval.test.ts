/**
 * ApprovalRegistry unit tests (PR4) — the pending-approval state machine that
 * backs acceptance criterion ② (phone approves → cc continues). No HTTP/ws here;
 * just the create → resolve / timeout / nonce logic.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalRegistry } from "./approval.js";

function makeRegistry(opts: Partial<ConstructorParameters<typeof ApprovalRegistry>[0]> = {}) {
  return new ApprovalRegistry({
    timeoutMs: opts.timeoutMs ?? 50,
    timeoutDecision: opts.timeoutDecision ?? "deny",
    now: opts.now,
  });
}

test("create() returns a pending approval whose promise resolves on resolve()", async () => {
  const reg = makeRegistry({ timeoutMs: 10_000 });
  const a = reg.create("Bash", { command: "ls" });
  assert.equal(reg.pendingCount, 1);

  const status = reg.resolve(a.id, "allow");
  assert.equal(status, "resolved");
  assert.equal(await a.promise, "allow");
  assert.equal(reg.pendingCount, 0);
});

test("a pending approval resolves with the fail-closed default on timeout", async () => {
  const reg = makeRegistry({ timeoutMs: 20, timeoutDecision: "deny" });
  const a = reg.create("Bash", { command: "rm -rf /" });
  // No human answers within the window → deny.
  assert.equal(await a.promise, "deny");
});

test("resolve via ws channel (no nonce) settles the approval", async () => {
  const reg = makeRegistry({ timeoutMs: 10_000 });
  const a = reg.create("Edit", { path: "x.ts" });
  assert.equal(reg.resolve(a.id, "allow"), "resolved");
  assert.equal(await a.promise, "allow");
});

test("resolve via ntfy channel requires the correct single-use nonce", async () => {
  const reg = makeRegistry({ timeoutMs: 10_000 });
  const a = reg.create("Bash", { command: "ls" });

  // Wrong nonce → rejected, NOT resolved.
  assert.equal(reg.resolve(a.id, "allow", { viaNonce: "wrong" }), "bad-nonce");
  assert.equal(reg.pendingCount, 1);

  // Correct nonce → resolved.
  assert.equal(reg.resolve(a.id, "deny", { viaNonce: a.nonce }), "resolved");
  assert.equal(await a.promise, "deny");
});

test("a second resolve for an already-settled id is idempotent (already-settled)", async () => {
  const reg = makeRegistry({ timeoutMs: 10_000 });
  const a = reg.create("Bash", { command: "ls" });
  assert.equal(reg.resolve(a.id, "allow"), "resolved");
  assert.equal(await a.promise, "allow");
  // The first decision wins; a retry / double-tap is a friendly no-op.
  assert.equal(reg.resolve(a.id, "deny"), "already-settled");
  assert.equal(await a.promise, "allow");
});

test("a wrong nonce on an already-settled id reports bad-nonce, not already-settled", async () => {
  const reg = makeRegistry({ timeoutMs: 10_000 });
  const a = reg.create("Bash", { command: "ls" });
  reg.resolve(a.id, "allow", { viaNonce: a.nonce });
  await a.promise;
  // The nonce check runs first so a wrong nonce never reveals the id existed.
  assert.equal(reg.resolve(a.id, "deny", { viaNonce: "nope" }), "bad-nonce");
});

test("resolve of an unknown id reports unknown", () => {
  const reg = makeRegistry({ timeoutMs: 10_000 });
  assert.equal(reg.resolve("does-not-exist", "allow"), "unknown");
});

test("onCreated fires for each new approval with its id/toolName/input", () => {
  const reg = makeRegistry({ timeoutMs: 10_000 });
  const seen: { id: string; toolName: string }[] = [];
  reg.onCreated((a) => seen.push({ id: a.id, toolName: a.toolName }));
  const a = reg.create("Bash", { command: "ls" });
  assert.deepEqual(seen, [{ id: a.id, toolName: "Bash" }]);
});

test("onResolved fires once with the decision on resolve and on timeout", async () => {
  const reg = makeRegistry({ timeoutMs: 20, timeoutDecision: "deny" });
  const events: { id: string; decision: string }[] = [];
  reg.onResolved((e) => events.push({ id: e.id, decision: e.decision }));

  const a = reg.create("Bash", { command: "ls" });
  reg.resolve(a.id, "allow");
  await a.promise;

  const b = reg.create("Bash", { command: "sleep" });
  await b.promise; // times out → deny

  assert.deepEqual(events, [
    { id: a.id, decision: "allow" },
    { id: b.id, decision: "deny" },
  ]);
});

test("each approval gets a distinct id and nonce", () => {
  const reg = makeRegistry({ timeoutMs: 10_000 });
  const a = reg.create("Bash", {});
  const b = reg.create("Bash", {});
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.nonce, b.nonce);
});
