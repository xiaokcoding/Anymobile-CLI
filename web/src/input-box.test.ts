/**
 * Pure input-box logic tests (PR3) — no DOM, runs under tsx like the reconnect
 * tests. Covers the submit/IME decision and the wire-payload builder that the
 * mobile input box relies on (prd Requirements: send prompts, IME double-type
 * guard).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { shouldSubmit, buildSubmitPayload, SUBMIT_KEY } from "./input-box.js";

test("shouldSubmit: plain Enter submits", () => {
  assert.equal(shouldSubmit({ key: "Enter", shiftKey: false }, false), true);
});

test("shouldSubmit: Enter during IME composition never submits (pinyin/IME guard)", () => {
  // The Enter belongs to the IME candidate selection, not the prompt.
  assert.equal(shouldSubmit({ key: "Enter", shiftKey: false }, true), false);
});

test("shouldSubmit: Shift+Enter inserts a newline instead of submitting", () => {
  assert.equal(shouldSubmit({ key: "Enter", shiftKey: true }, false), false);
});

test("shouldSubmit: non-Enter keys never submit", () => {
  assert.equal(shouldSubmit({ key: "a", shiftKey: false }, false), false);
  assert.equal(shouldSubmit({ key: "Tab", shiftKey: false }, false), false);
});

test("buildSubmitPayload: appends a trailing CR so Claude submits", () => {
  assert.equal(buildSubmitPayload("hello"), "hello" + SUBMIT_KEY);
});

test("buildSubmitPayload: empty / whitespace-only input is dropped (returns null)", () => {
  assert.equal(buildSubmitPayload(""), null);
  assert.equal(buildSubmitPayload("   "), null);
  assert.equal(buildSubmitPayload("\n\t "), null);
});

test("buildSubmitPayload: preserves internal whitespace in the prompt", () => {
  // Only the emptiness check uses trim(); the sent content is verbatim + CR.
  assert.equal(buildSubmitPayload("  spaced  text  "), "  spaced  text  " + SUBMIT_KEY);
  assert.equal(buildSubmitPayload("line1\nline2"), "line1\nline2" + SUBMIT_KEY);
});
