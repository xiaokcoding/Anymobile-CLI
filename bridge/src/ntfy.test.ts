/**
 * NtfyClient unit tests (PR4) — outbound push with a mocked fetch. Asserts the
 * JSON-publishing shape (topic/title/message/actions) and the "no topic → skip,
 * don't fail" behaviour, plus the http-action button URLs (built via api-server's
 * buildApprovalActions) carrying the single-use nonce, NOT the bridge token.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { NtfyClient } from "./ntfy.js";
import { buildApprovalActions } from "./api-server.js";

/** A fake fetch that records the last call and returns a configurable status. */
function fakeFetch(status = 200): {
  fetch: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

test("publish() POSTs JSON to the ntfy server with the topic and message", async () => {
  const { fetch, calls } = fakeFetch();
  const client = new NtfyClient({ server: "https://ntfy.example", topic: "secret-topic", fetchImpl: fetch });

  const ok = await client.publish({ title: "T", message: "M", priority: 5, tags: ["lock"] });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://ntfy.example");
  assert.equal(calls[0]!.init?.method, "POST");

  const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
  assert.equal(body.topic, "secret-topic");
  assert.equal(body.title, "T");
  assert.equal(body.message, "M");
  assert.equal(body.priority, 5);
  assert.deepEqual(body.tags, ["lock"]);
});

test("publish() includes http-action buttons when provided", async () => {
  const { fetch, calls } = fakeFetch();
  const client = new NtfyClient({ server: "https://ntfy.example", topic: "t", fetchImpl: fetch });

  const actions = buildApprovalActions("https://host.ts.net", "ID1", "NONCE1");
  await client.publish({ message: "approve?", actions });

  const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
  const sent = body.actions as Array<Record<string, unknown>>;
  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.label, "通过");
  assert.equal(sent[1]!.label, "拒绝");
  // URLs carry the nonce (NOT the bridge token) and the decision.
  assert.match(String(sent[0]!.url), /\/approvals\/ID1\?decision=allow&nonce=NONCE1$/);
  assert.match(String(sent[1]!.url), /\/approvals\/ID1\?decision=deny&nonce=NONCE1$/);
  assert.equal(sent[0]!.method, "POST");
  assert.equal(sent[0]!.clear, true);
});

test("publish() is a no-op (returns false) and does NOT fetch when no topic is set", async () => {
  const { fetch, calls } = fakeFetch();
  const client = new NtfyClient({ server: "https://ntfy.example", topic: undefined, fetchImpl: fetch, warn: () => undefined });

  const ok = await client.publish({ message: "ignored" });
  assert.equal(ok, false);
  assert.equal(calls.length, 0); // no push attempted, but no throw either
  assert.equal(client.enabled, false);
});

test("publish() returns false (not throw) on a non-2xx response", async () => {
  const { fetch } = fakeFetch(500);
  const client = new NtfyClient({ server: "https://ntfy.example", topic: "t", fetchImpl: fetch, warn: () => undefined });
  assert.equal(await client.publish({ message: "x" }), false);
});

test("publish() returns false (not throw) when fetch itself throws", async () => {
  const throwing = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const client = new NtfyClient({ server: "https://ntfy.example", topic: "t", fetchImpl: throwing, warn: () => undefined });
  assert.equal(await client.publish({ message: "x" }), false);
});

test("buildApprovalActions strips a trailing slash on the base URL", () => {
  const actions = buildApprovalActions("https://host.ts.net/", "ID", "N");
  assert.match(String(actions[0]!.url), /^https:\/\/host\.ts\.net\/approvals\/ID\?/);
});
