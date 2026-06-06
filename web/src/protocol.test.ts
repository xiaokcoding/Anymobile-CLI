/**
 * Web protocol parse/serialize tests (PR4) — focused on the approval frames added
 * this PR, since they must stay byte-compatible with bridge/src/protocol.ts (the
 * two files are hand-kept in sync). Runs under tsx like the other web tests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseServerMessage, serializeClientMessage } from "./protocol.js";

test("parseServerMessage decodes a well-formed approval_request", () => {
  const msg = parseServerMessage(
    JSON.stringify({
      type: "approval_request",
      id: "abc",
      toolName: "Bash",
      toolInput: "rm -rf build",
      createdAt: 1717200000000,
    }),
  );
  assert.ok(msg && msg.type === "approval_request");
  assert.equal(msg.id, "abc");
  assert.equal(msg.toolName, "Bash");
  assert.equal(msg.toolInput, "rm -rf build");
  assert.equal(msg.createdAt, 1717200000000);
});

test("parseServerMessage rejects an approval_request missing fields", () => {
  assert.equal(parseServerMessage(JSON.stringify({ type: "approval_request", id: "x" })), null);
});

test("parseServerMessage decodes approval_resolved with a valid decision", () => {
  const msg = parseServerMessage(JSON.stringify({ type: "approval_resolved", id: "x", decision: "deny" }));
  assert.ok(msg && msg.type === "approval_resolved");
  assert.equal(msg.decision, "deny");
});

test("parseServerMessage rejects approval_resolved with a bad decision", () => {
  assert.equal(
    parseServerMessage(JSON.stringify({ type: "approval_resolved", id: "x", decision: "maybe" })),
    null,
  );
});

test("serializeClientMessage round-trips an approval_decision", () => {
  const wire = serializeClientMessage({ type: "approval_decision", id: "x", decision: "allow" });
  assert.deepEqual(JSON.parse(wire), { type: "approval_decision", id: "x", decision: "allow" });
});

test("existing frames still parse (regression: ready / output / pong unchanged)", () => {
  assert.ok(
    parseServerMessage(
      JSON.stringify({ type: "ready", cols: 80, rows: 24, lastSeq: 0, alive: true, truncated: false }),
    ),
  );
  assert.ok(parseServerMessage(JSON.stringify({ type: "output", seq: 1, data: "x" })));
  assert.ok(parseServerMessage(JSON.stringify({ type: "pong" })));
});
