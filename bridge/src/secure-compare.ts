/**
 * Constant-time secret comparison for the PR4 auth boundary (dispatch constraint
 * 1; .trellis/spec/backend/bridge-serving.md). Used to compare the BRIDGE_TOKEN
 * (ws `?token=` + cc hook `Authorization: Bearer`) and the per-approval nonce
 * (ntfy http-action callback) against the supplied credential.
 *
 * Why not `a === b`: a plain string `===` short-circuits on the first differing
 * byte AND on a length mismatch, leaking a prefix-matching timing signal and the
 * secret's length. These secrets are UUIDs reachable over the tailnet, so we
 * compare in time that does not depend on WHERE the mismatch is.
 *
 * We SHA-256 both sides to a fixed 32-byte digest before `crypto.timingSafeEqual`
 * (which itself throws on a length mismatch). Hashing first means:
 *   - the compared buffers are always the same length, so no length-dependent
 *     early return and no length leak;
 *   - timingSafeEqual then runs in time independent of the differing position.
 * The extra hash on a missing/short attacker input is negligible and the secret
 * is never branched on directly.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * True iff `a` and `b` are the same string, compared in constant time w.r.t. the
 * position/length of any mismatch. Safe to pass attacker-controlled input as
 * either argument.
 */
export function secureEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  // Both digests are 32 bytes, so timingSafeEqual never throws here.
  return timingSafeEqual(ha, hb);
}
