/**
 * Pure reconnect/replay logic tests (PR2) — no DOM, runs under tsx like the
 * bridge tests. Covers the backoff arithmetic and the seq de-dup/reset contract
 * that keeps the replay→live boundary gap-free (acceptance criterion ③).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { backoffDelayMs, SeqCursor } from "./reconnect.js";
import { Backoff } from "./protocol.js";

test("backoff grows geometrically: 300, 540, 972, ...", () => {
  assert.equal(backoffDelayMs(0), 300); // 300 * 1.8^0
  assert.equal(backoffDelayMs(1), 540); // 300 * 1.8^1
  assert.equal(backoffDelayMs(2), 972); // 300 * 1.8^2
});

test("backoff is capped at maxMs (5000) for large attempt counts", () => {
  assert.equal(backoffDelayMs(10), Backoff.maxMs);
  assert.equal(backoffDelayMs(100), Backoff.maxMs);
  // The first attempt at/after the cap clamps rather than overshooting.
  assert.ok(backoffDelayMs(5) <= Backoff.maxMs);
});

test("backoff clamps negative/zero attempts to the base delay", () => {
  assert.equal(backoffDelayMs(-3), Backoff.baseMs);
  assert.equal(backoffDelayMs(0), Backoff.baseMs);
});

test("SeqCursor accepts strictly-increasing seqs exactly once", () => {
  const cursor = new SeqCursor(0);
  assert.equal(cursor.accept(1), true);
  assert.equal(cursor.value, 1);
  assert.equal(cursor.accept(2), true);
  assert.equal(cursor.value, 2);
});

test("SeqCursor drops already-seen seqs (replay→live overlap de-dup)", () => {
  const cursor = new SeqCursor(2); // client already rendered through seq 2
  // Replay re-delivers seq 1 and 2 (overlap) — both dropped.
  assert.equal(cursor.accept(1), false);
  assert.equal(cursor.accept(2), false);
  // The genuinely new live chunk (seq 3) is accepted.
  assert.equal(cursor.accept(3), true);
  assert.equal(cursor.value, 3);
});

test("SeqCursor.reset rewinds to 0 so a truncated full replay re-renders", () => {
  const cursor = new SeqCursor(50);
  cursor.reset();
  assert.equal(cursor.value, 0);
  // After a truncation reset the full-buffer replay (starting at some seq) is
  // accepted from scratch.
  assert.equal(cursor.accept(48), true);
  assert.equal(cursor.accept(49), true);
});
