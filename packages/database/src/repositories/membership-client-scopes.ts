import { and, asc, eq } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import { newId } from '../ids.js';
import { membershipClientScopes } from '../schema/index.js';
import type { TenantContext } from '../tenant/context.js';
import { requireRow } from './util.js';

export type MembershipClientScopeRecord = typeof membershipClientScopes.$inferSelect;

export interface AddMembershipClientScopeInput {
  membershipId: string;
  clientId: string;
}

export interface MembershipClientScopeRepository {
  add(input: AddMembershipClientScopeInput): Promise<MembershipClientScopeRecord>;
  listByMembership(membershipId: string): Promise<MembershipClientScopeRecord[]>;
  /** Every scope row of the organization, so a member list is one query, not N. */
  listForOrganization(): Promise<MembershipClientScopeRecord[]>;
  remove(membershipId: string, clientId: string): Promise<boolean>;
  /**
   * Removes every scope row of one membership.
   *
   * The first half of a scope *replacement*: `PUT` semantics mean the request states
   * the complete resulting access, so the previous rows go and the submitted ones
   * arrive, both inside the caller's transaction. There is no window in which the
   * membership holds a partially-applied scope.
   *
   * @returns the number of rows removed.
   */
  deleteAllForMembership(membershipId: string): Promise<number>;
}

/**
 * Client-level restriction of a membership.
 *
 * Cross-organization scopes are impossible by schema: the composite foreign keys
 * require the membership and the client to share this row's organization, so a
 * membership in one organization cannot be scoped to another organization's client
 * even if a caller supplies both identifiers (migration 0001).
 */
export function createMembershipClientScopeRepository(
  tx: Transaction,
  tenant: TenantContext,
): MembershipClientScopeRepository {
  const scoped = eq(membershipClientScopes.organizationId, tenant.organizationId);

  return {
    async add(input: AddMembershipClientScopeInput): Promise<MembershipClientScopeRecord> {
      const rows = await tx
        .insert(membershipClientScopes)
        .values({
          id: newId(),
          organizationId: tenant.organizationId,
          membershipId: input.membershipId,
          clientId: input.clientId,
        })
        .returning();

      return requireRow(rows, 'membershipClientScopes.add');
    },

    async listByMembership(membershipId: string): Promise<MembershipClientScopeRecord[]> {
      return tx
        .select()
        .from(membershipClientScopes)
        .where(and(eq(membershipClientScopes.membershipId, membershipId), scoped))
        .orderBy(asc(membershipClientScopes.createdAt));
    },

    async listForOrganization(): Promise<MembershipClientScopeRecord[]> {
      return tx
        .select()
        .from(membershipClientScopes)
        .where(scoped)
        .orderBy(asc(membershipClientScopes.membershipId), asc(membershipClientScopes.createdAt));
    },

    async deleteAllForMembership(membershipId: string): Promise<number> {
      const rows = await tx
        .delete(membershipClientScopes)
        .where(and(eq(membershipClientScopes.membershipId, membershipId), scoped))
        .returning({ id: membershipClientScopes.id });

      return rows.length;
    },

    async remove(membershipId: string, clientId: string): Promise<boolean> {
      const rows = await tx
        .delete(membershipClientScopes)
        .where(
          and(
            eq(membershipClientScopes.membershipId, membershipId),
            eq(membershipClientScopes.clientId, clientId),
            scoped,
          ),
        )
        .returning({ id: membershipClientScopes.id });

      return rows.length > 0;
    },
  };
}
