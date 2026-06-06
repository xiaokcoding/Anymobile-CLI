/**
 * Pure approval-store logic for the PWA — no DOM, so it's unit testable in
 * isolation (web/src/approvals.test.ts). The DOM rendering (cards, allow/deny
 * buttons) lives in main.ts; the "which approvals are pending right now" state
 * machine lives here.
 *
 * The store mirrors the bridge's pending-approval set from the ws frames:
 *   - `approval_request{id,toolName,toolInput,createdAt}` adds a pending entry.
 *   - `approval_resolved{id,decision}` removes it (resolved via ANY channel: this
 *     phone's card, another client, an ntfy button, or the bridge timeout).
 *
 * It's deliberately last-writer-wins and idempotent: a duplicate request for the
 * same id replaces in place; a resolve for an unknown/already-removed id is a
 * no-op. That keeps the UI consistent across reconnects (the bridge re-broadcasts
 * nothing on reconnect, but a resolve may arrive before/after a stale request).
 */

import type { ApprovalDecision } from "./protocol.js";

/** A pending approval the user can act on, as shown on a card. */
export interface PendingApproval {
  readonly id: string;
  readonly toolName: string;
  readonly toolInput: string;
  readonly createdAt: number;
}

export class ApprovalStore {
  private readonly pending = new Map<string, PendingApproval>();

  /** Add (or replace) a pending approval. Returns true if the set changed. */
  add(approval: PendingApproval): boolean {
    const existing = this.pending.get(approval.id);
    if (existing && shallowEqual(existing, approval)) return false;
    this.pending.set(approval.id, approval);
    return true;
  }

  /** Remove a resolved approval. Returns true if something was removed. */
  resolve(id: string): boolean {
    return this.pending.delete(id);
  }

  /** True if the given id is currently pending. */
  has(id: string): boolean {
    return this.pending.has(id);
  }

  get size(): number {
    return this.pending.size;
  }

  /** Pending approvals, oldest first (stable display order). */
  list(): PendingApproval[] {
    return [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
}

/** Re-export so callers can type a decision without importing protocol directly. */
export type { ApprovalDecision };

function shallowEqual(a: PendingApproval, b: PendingApproval): boolean {
  return (
    a.id === b.id &&
    a.toolName === b.toolName &&
    a.toolInput === b.toolInput &&
    a.createdAt === b.createdAt
  );
}
