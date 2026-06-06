/**
 * Pure ApprovalStore logic tests (PR4) — no DOM, runs under tsx like the other
 * web tests. Covers the add/resolve state machine the approval cards mirror from
 * the ws frames (acceptance criterion ②: approve from the phone).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalStore, type PendingApproval } from "./approvals.js";

function approval(id: string, createdAt = 0): PendingApproval {
  return { id, toolName: "Bash", toolInput: "ls", createdAt };
}

test("add() makes an approval pending and reports the change", () => {
  const store = new ApprovalStore();
  assert.equal(store.add(approval("a")), true);
  assert.equal(store.has("a"), true);
  assert.equal(store.size, 1);
});

test("add() of an identical approval again is a no-op (returns false)", () => {
  const store = new ApprovalStore();
  store.add(approval("a"));
  assert.equal(store.add(approval("a")), false);
  assert.equal(store.size, 1);
});

test("add() replaces in place when the same id arrives with new fields", () => {
  const store = new ApprovalStore();
  store.add({ id: "a", toolName: "Bash", toolInput: "ls", createdAt: 1 });
  assert.equal(store.add({ id: "a", toolName: "Edit", toolInput: "x.ts", createdAt: 1 }), true);
  assert.equal(store.size, 1);
  assert.equal(store.list()[0]!.toolName, "Edit");
});

test("resolve() removes a pending approval and reports whether it was present", () => {
  const store = new ApprovalStore();
  store.add(approval("a"));
  assert.equal(store.resolve("a"), true);
  assert.equal(store.has("a"), false);
  assert.equal(store.size, 0);
  // Resolving an unknown / already-removed id is a harmless no-op.
  assert.equal(store.resolve("a"), false);
});

test("list() returns pending approvals oldest-first", () => {
  const store = new ApprovalStore();
  store.add(approval("late", 200));
  store.add(approval("early", 100));
  store.add(approval("mid", 150));
  assert.deepEqual(
    store.list().map((a) => a.id),
    ["early", "mid", "late"],
  );
});
