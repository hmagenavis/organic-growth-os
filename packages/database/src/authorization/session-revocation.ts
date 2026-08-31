import { and, eq, isNull } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import { sessions } from '../schema/index.js';

/**
 * Server-side session revocation, bound to an existing transaction.
 *
 * ## Why this exists next to a perfectly good `SessionService`
 *
 * `SessionService.revokeAllForUser` is the right primitive, and Phase 0.3 built it
 * for exactly this purpose. It reaches the database through `AuthStore`, which opens
 * its own transaction per call — correct for authentication, and wrong here, because
 * a membership mutation and the revocation it forces must not be able to disagree.
 *
 * The state to avoid is a membership that changed while the affected user's sessions
 * stayed live: the role was lowered, the client scope shrank, the membership was
 * removed, and a browser somewhere still holds a session established under the old
 * authorization. Two transactions can produce it in two ways — the revocation fails
 * after the membership commits, or the process dies between them. No retry loop or
 * compensating write removes that window; it only makes it smaller.
 *
 * ## Why one transaction is actually possible here
 *
 * `sessions` is deliberately outside Row Level Security (migration 0002): a session
 * is resolved from a token hash before any organization is known, so a tenant
 * predicate could not be evaluated on it. The runtime role therefore holds an
 * ordinary `UPDATE` grant on the table, with no policy to satisfy — which means this
 * statement is legal inside the very transaction that already carries
 * `app.current_org_id` for the membership write.
 *
 * So the membership change and the revocation are one commit. Either both happened
 * or neither did; there is no partially-applied security mutation to detect, alert
 * on or repair (ADR-0017).
 *
 * ## What this does not do
 *
 * It does not rotate anything. Rotation replaces the *caller's own* session and
 * needs the raw cookie token, which an administrator acting on another member does
 * not have and must never be given. Revocation is the correct primitive for
 * administrative action on someone else: it is server-side, needs no token, and
 * takes effect on that member's next request (§8 of the sub-phase brief).
 *
 * It is also not exported from the package. The only caller is the member
 * administration service, which reaches it through
 * `AuthorizedOrganizationSession.revokeMemberSessions`, and that method accepts a
 * membership record read under the authorized organization — so a user with no
 * membership in the organization being administered cannot be logged out from here.
 */

/**
 * Marks every live session of one user revoked.
 *
 * Already-revoked rows are excluded by the predicate, so `revoked_at` records when a
 * session actually ended rather than when someone last ran a revocation, and the
 * returned count is the number of sessions this call really killed.
 *
 * @returns how many live sessions were revoked.
 */
export async function revokeAllSessionsForUserInTransaction(
  tx: Transaction,
  userId: string,
  at: Date,
): Promise<number> {
  const rows = await tx
    .update(sessions)
    .set({ revokedAt: at })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });

  return rows.length;
}
