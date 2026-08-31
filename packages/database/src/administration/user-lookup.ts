import { normalizeEmail } from '@organic-os/auth';
import { eq, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { users } from '../schema/index.js';

/**
 * Resolving an email address to a platform user id, for member administration.
 *
 * ## Why this is not a tenant query
 *
 * The user an administrator wants to attach is by definition *not yet* a member of
 * the organization, so `users_read_same_organization` (migration 0002) cannot see
 * them: that policy admits a user row only while the user already holds a membership
 * in the current organization. The only other read path on `users` is the
 * authentication point lookup added by migration 0003 — `email = app.auth_email()`,
 * which returns at most the one row whose exact address was supplied and nothing
 * when the setting is unset.
 *
 * This function uses that point lookup, in **its own transaction, with no tenant
 * context established**. That placement is the whole point. Migration 0003 states
 * that a request carries either a tenant context or an authentication context and
 * never both, because the application establishes them through separate entry points
 * in separate transactions. Setting `app.auth_email` inside an authorized tenant
 * transaction would break that invariant and quietly widen what any code running
 * under a tenant context can read. So the lookup happens before the tenant
 * transaction opens, and hands forward a user id — nothing else.
 *
 * ## Ordering, and why it matters
 *
 * The caller must have proven `member.invite_or_create` in the organization *before*
 * calling this. `createMemberAdministrationService` does exactly that: it opens an
 * authorize-only transaction first, and only a proven agency admin ever reaches this
 * function. Without that ordering the endpoint would be an unauthenticated existence
 * oracle for arbitrary addresses.
 *
 * ## Residual risk, stated rather than hidden
 *
 * Even with that ordering, an agency admin can learn whether a given address has a
 * platform account, because "attached" and `INVITATION_FLOW_NOT_IMPLEMENTED` are
 * necessarily different answers. That is inherent to attaching an existing user and
 * is accepted for Phase 0 (§3 of the sub-phase brief); the invitation flow of 0.4.2B
 * removes it, because an invitation is issued the same way whether or not an account
 * exists. It is recorded in docs/phases/PHASE-0.4.2A-IMPLEMENTATION.md.
 *
 * @returns the user id, or null when no account exists for that address.
 */
export async function findUserIdByEmail(db: Database, email: string): Promise<string | null> {
  // The same normalisation login uses, so an address that can authenticate is the
  // same address that can be attached. `users.email` is citext, so the comparison is
  // case-insensitive in the database too.
  const normalized = normalizeEmail(email);

  if (normalized === '') {
    return null;
  }

  return db.transaction(async (tx) => {
    // Transaction-local, exactly as in `auth/store.ts`. Discarded at COMMIT and at
    // ROLLBACK, so it cannot survive the connection returning to the pool.
    await tx.execute(sql`SELECT set_config('app.auth_email', ${normalized}, true)`);

    // Only the id is selected. `password_hash` and `is_platform_admin` are on this
    // row and neither is needed to attach a membership.
    const rows = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalized))
      .limit(1);

    return rows[0]?.id ?? null;
  });
}
