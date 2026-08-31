import type {
  AuthorizationMembership,
  MembershipStore,
  MembershipSummary,
} from '@organic-os/authorization';
import { and, asc, eq, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../client.js';
import { memberships, organizations } from '../schema/index.js';

/**
 * PostgreSQL implementation of the authorization bootstrap port (ADR-0011).
 *
 * ## The bootstrap problem
 *
 * Tenant context may be established only after membership is proven. But membership
 * rows are themselves tenant-scoped (migration 0002), so proving membership cannot
 * require the tenant context it exists to authorize. Something has to break the
 * circle.
 *
 * ## What breaks it
 *
 * A transaction-local setting, `app.authz_user_id`, and two policies added by
 * migration 0004:
 *
 * ```sql
 * CREATE POLICY memberships_authorization_bootstrap ON memberships
 *   FOR SELECT TO organic_os_runtime
 *   USING (app.current_org_id() IS NULL AND user_id = app.authz_user_id());
 * ```
 *
 * Four properties follow, and each has a test in `authorization.int.test.ts`:
 *
 *   1. **Only your own memberships.** The predicate compares against the setting this
 *      module writes, and this module writes only the id of the authenticated user
 *      the caller arrived as. There is no method here that takes an arbitrary user.
 *   2. **Fails closed.** `app.authz_user_id()` is NULL when unset, so a query issued
 *      without establishing the context matches nothing — the same shape as
 *      `app.current_org_id()`.
 *   3. **Cannot widen a tenant query.** The policy is inert whenever
 *      `app.current_org_id()` is set, so the bootstrap path and the tenant path are
 *      disjoint by construction rather than by discipline.
 *   4. **Grants no tenant access.** Nothing here sets `app.current_org_id`.
 *      Establishing the bootstrap context lets the caller read its own membership
 *      rows and the organizations those rows point at — no clients, no sites, no
 *      settings, no audit log, and no other user's memberships.
 *
 * There is no `BYPASSRLS` role, no `SECURITY DEFINER` function and no privileged
 * connection involved: this runs as the ordinary runtime role, subject to FORCE RLS,
 * exactly like every other application query.
 *
 * ## No caching
 *
 * Both methods hit the database on every call. Authorization state that outlives a
 * request is authorization state that survives a membership being revoked, so
 * Phase 0 pays one indexed point lookup per request instead (§17 of the sub-phase
 * brief).
 */

/** Establishes the bootstrap context. Transaction-local; never session-level. */
async function applyAuthorizationContext(tx: Transaction, userId: string): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.authz_user_id', ${userId}, true)`);
}

export function createMembershipStore(db: Database): MembershipStore {
  return {
    async findMembership(
      userId: string,
      organizationId: string,
    ): Promise<AuthorizationMembership | null> {
      return db.transaction(async (tx) => {
        await applyAuthorizationContext(tx, userId);

        // Both halves of the key are in the predicate, so the policy and the query
        // agree: this returns the caller's membership in that organization or
        // nothing. UNIQUE (organization_id, user_id) from migration 0001 makes it a
        // single-row index lookup.
        const rows = await tx
          .select({
            membershipId: memberships.id,
            organizationId: memberships.organizationId,
            userId: memberships.userId,
            role: memberships.role,
            clientAccessMode: memberships.clientAccessMode,
          })
          .from(memberships)
          .where(
            and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId)),
          )
          .limit(1);

        return rows[0] ?? null;
      });
    },

    async listMemberships(userId: string): Promise<readonly MembershipSummary[]> {
      return db.transaction(async (tx) => {
        await applyAuthorizationContext(tx, userId);

        // One join, not a query per organization: the organizations policy added by
        // 0004 admits exactly the rows this user's memberships point at.
        return (
          tx
            .select({
              membershipId: memberships.id,
              organizationId: memberships.organizationId,
              organizationName: organizations.name,
              organizationSlug: organizations.slug,
              role: memberships.role,
              clientAccessMode: memberships.clientAccessMode,
            })
            .from(memberships)
            .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
            .where(eq(memberships.userId, userId))
            // Deterministic order, so organization selection is reproducible.
            .orderBy(asc(organizations.name), asc(memberships.organizationId))
        );
      });
    },
  };
}
