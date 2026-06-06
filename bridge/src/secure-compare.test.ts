/**
 * secureEqual unit tests (PR4 auth boundary). Verifies the constant-time secret
 * comparison used for BRIDGE_TOKEN (ws + cc hook) and the per-approval nonce.
 * We assert correctness (equal vs not) including length-mismatch and empty cases;
 * the constant-time property itself isn't timing-asserted (flaky), but the
 * SHA-256-then-timingSafeEqual implementation guarantees it structurally.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { secureEqual } from "./secure-compare.js";

test("secureEqual is true for identical strings", () => {
  assert.equal(secureEqual("abc123", "abc123"), true);
  const uuid = "11111111-2222-3333-4444-555555555555";
  assert.equal(secureEqual(uuid, uuid), true);
});

test("secureEqual is false for differing strings of equal length", () => {
  assert.equal(secureEqual("abcdef", "abcdeg"), false);
  assert.equal(secureEqual("abcdef", "zbcdef"), false);
});

test("secureEqual is false for different-length strings (no throw)", () => {
  // SHA-256 makes both sides 32 bytes so timingSafeEqual never throws on length.
  assert.equal(secureEqual("short", "a-much-longer-secret"), false);
  assert.equal(secureEqual("", "x"), false);
  assert.equal(secureEqual("x", ""), false);
});

test("secureEqual is true for two empty strings", () => {
  assert.equal(secureEqual("", ""), true);
});

test("secureEqual handles unicode without splitting code points", () => {
  assert.equal(secureEqual("通过-✅", "通过-✅"), true);
  assert.equal(secureEqual("通过-✅", "拒绝-✅"), false);
});
