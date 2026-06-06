/**
 * ApprovalRegistry — the bridge's pending-approval table for moshi-style remote
 * approval (PR4, prd 验收② + research/claude-code-hooks-approval.md §2).
 *
 * Flow (all three resolution channels target the SAME pending entry):
 *   1. cc's `PreToolUse` (type:http) hook POSTs the tool context to the bridge
 *      and SYNCHRONOUSLY blocks on the HTTP response (research §2.2). The bridge
 *      calls `create()`, which returns a `promise` the hook handler awaits.
 *   2. The bridge surfaces the request through THREE channels (any one resolves
 *      the one pending entry — the others then no-op):
 *        a) an ntfy push with two http-action buttons (allow/deny) whose URLs
 *           carry a single-use `nonce` (so the long-lived BRIDGE_TOKEN is never
 *           leaked to ntfy.sh) → `resolve(id, decision, { viaNonce })`;
 *        b) a `approval_request` ws broadcast → PWA card → `approval_decision`
 *           ws frame (already token-authed at the ws handshake, no nonce needed);
 *        c) the PWA opened from the push.
 *   3. On the first resolve (or timeout) the promise settles with the decision
 *      and `approval_resolved{id,decision}` is broadcast so every card/notice
 *      across clients clears.
 *
 * Fail-closed: if no human answers within `timeoutMs` (default 280s, kept under
 * cc's 300s hook timeout so the bridge always answers first), the entry resolves
 * with `timeoutDecision` (default deny). A phone that's offline / nobody-home
 * therefore still gets a definite decision back to cc before its hook times out
 * (research §2.3).
 *
 * The nonce is the load-bearing security detail for channel (a): ntfy.sh sees the
 * action URLs, so they must NOT contain the reusable bridge token. A per-request
 * random nonce, bound to one id and consumed on first use, scopes the capability
 * to exactly this one approval.
 */

import { randomUUID } from "node:crypto";
import type { ApprovalDecision } from "./config.js";
import { secureEqual } from "./secure-compare.js";

export type { ApprovalDecision };

/** A pending approval awaiting a human (or timeout) decision. */
export interface PendingApproval {
  readonly id: string;
  /** Single-use secret embedded in ntfy http-action URLs (channel a). */
  readonly nonce: string;
  /** Tool the model wants to run, surfaced to the human. */
  readonly toolName: string;
  /** Arbitrary tool input from cc, surfaced (summarised) to the human. */
  readonly toolInput: unknown;
  /** Settles when resolved via any channel, or with the fail-closed default on timeout. */
  readonly promise: Promise<ApprovalDecision>;
  /** ms since epoch the request was created (for the card / debugging). */
  readonly createdAt: number;
}

/** Emitted when an approval is resolved (or times out) so all clients can clear it. */
export interface ApprovalResolvedEvent {
  readonly id: string;
  readonly decision: ApprovalDecision;
}

export interface ApprovalRegistryOptions {
  /** Wait this long for a human decision before applying `timeoutDecision`. */
  readonly timeoutMs: number;
  /** Decision applied when an approval times out (fail-closed → deny). */
  readonly timeoutDecision: ApprovalDecision;
  /** Optional clock injection for deterministic tests. */
  readonly now?: () => number;
}

interface Entry {
  readonly approval: PendingApproval;
  readonly nonce: string;
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
  /** The decision once settled (for idempotent retries). */
  decision: ApprovalDecision | null;
}

export class ApprovalRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly timeoutMs: number;
  private readonly timeoutDecision: ApprovalDecision;
  private readonly now: () => number;
  private readonly resolvedListeners = new Set<(e: ApprovalResolvedEvent) => void>();
  private readonly createdListeners = new Set<(a: PendingApproval) => void>();

  constructor(options: ApprovalRegistryOptions) {
    this.timeoutMs = options.timeoutMs;
    this.timeoutDecision = options.timeoutDecision;
    this.now = options.now ?? Date.now;
  }

  /** Subscribe to new pending approvals (the ws server broadcasts `approval_request`). */
  onCreated(listener: (a: PendingApproval) => void): () => void {
    this.createdListeners.add(listener);
    return () => this.createdListeners.delete(listener);
  }

  /** Subscribe to resolve/timeout events (the ws server broadcasts `approval_resolved`). */
  onResolved(listener: (e: ApprovalResolvedEvent) => void): () => void {
    this.resolvedListeners.add(listener);
    return () => this.resolvedListeners.delete(listener);
  }

  /**
   * Register a new pending approval. The returned `promise` settles when a human
   * decides via any channel, or with the fail-closed default after `timeoutMs`.
   */
  create(toolName: string, toolInput: unknown): PendingApproval {
    const id = randomUUID();
    const nonce = randomUUID();
    const createdAt = this.now();

    let resolveFn!: (decision: ApprovalDecision) => void;
    const promise = new Promise<ApprovalDecision>((resolve) => {
      resolveFn = resolve;
    });

    const approval: PendingApproval = { id, nonce, toolName, toolInput, promise, createdAt };
    const entry: Entry = {
      approval,
      nonce,
      resolve: resolveFn,
      timer: null,
      settled: false,
      decision: null,
    };

    // Fail-closed default if nobody answers in time. unref() so a pending timer
    // never keeps the process alive at shutdown.
    entry.timer = setTimeout(() => {
      this.settle(entry, this.timeoutDecision);
    }, this.timeoutMs);
    entry.timer.unref?.();

    this.entries.set(id, entry);
    for (const listener of this.createdListeners) listener(approval);
    return approval;
  }

  /**
   * Resolve a pending approval. Returns the resolution status so callers can map
   * it to an HTTP code:
   *   - "resolved": settled this call (200).
   *   - "already-settled": the entry exists but was already resolved (idempotent
   *     200 for ntfy retries / double taps).
   *   - "unknown": no such id (404) — also a long-evicted id.
   *   - "bad-nonce": a nonce was supplied (channel a) but didn't match (401).
   *
   * `viaNonce` is the single-use secret from an ntfy http-action URL. Channel (b)
   * (the ws card) is already token-authed at the handshake and passes no nonce.
   */
  resolve(
    id: string,
    decision: ApprovalDecision,
    opts: { viaNonce?: string } = {},
  ): "resolved" | "already-settled" | "unknown" | "bad-nonce" {
    const entry = this.entries.get(id);
    if (!entry) return "unknown";

    // Nonce path (ntfy http-action): must match, single-use. The ws path passes
    // no nonce (already authed at the handshake). We check the nonce even for an
    // already-settled entry so a wrong nonce never reveals "this id existed".
    // Constant-time compare: ntfy.sh sees the nonce in the action URL, so a wrong
    // guess must not be probable byte-by-byte by timing.
    if (opts.viaNonce !== undefined && !secureEqual(opts.viaNonce, entry.nonce)) {
      return "bad-nonce";
    }

    // Idempotent: a second tap / ntfy retry for an already-decided id is a no-op
    // success, not an error (the human already answered).
    if (entry.settled) return "already-settled";

    this.settle(entry, decision);
    return "resolved";
  }

  /** Whether an id is still pending (unsettled). */
  has(id: string): boolean {
    const entry = this.entries.get(id);
    return entry !== undefined && !entry.settled;
  }

  /** Count of currently-pending (unsettled) approvals — for diagnostics/tests. */
  get pendingCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) if (!entry.settled) n += 1;
    return n;
  }

  private settle(entry: Entry, decision: ApprovalDecision): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.decision = decision;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.resolve(decision);
    // Keep the settled entry briefly so a retrying ntfy http-action or a slow
    // second tap maps to "already-settled" (idempotent 200) instead of "unknown".
    // After the grace window we evict it to keep the map bounded; a later hit
    // then reports "unknown", which the handlers still answer gracefully.
    const evictTimer = setTimeout(() => this.entries.delete(entry.approval.id), SETTLED_GRACE_MS);
    evictTimer.unref?.();
    const event: ApprovalResolvedEvent = { id: entry.approval.id, decision };
    for (const listener of this.resolvedListeners) listener(event);
  }
}

/** How long a resolved entry lingers so retries are idempotent rather than "unknown". */
const SETTLED_GRACE_MS = 60_000;
