import {
  assertAgencyAdminRemains,
  assertClientAccessAllowedForRole,
  assertNotSelfMutation,
  AuthorizationError,
  isClientAccessNarrowing,
  MembershipAdministrationError,
  normalizeClientAccessForRole,
  type AuthenticatedIdentityRef,
  type ClientAccessState,
} from '@organic-os/authorization';
import { z } from 'zod';

import type {
  AuthorizationService,
  AuthorizedOrganizationSession,
} from '../authorization/with-authorized-organization.js';
import type { Database } from '../client.js';
import type { MembershipRecord, MembershipWithUser } from '../repositories/memberships.js';
import type { JsonObject } from '../schema/columns.js';
import type { AuditSource, ClientAccessMode, MembershipRole } from '../schema/enums.js';
import { findUserIdByEmail } from './user-lookup.js';

/**
 * Member administration: the orchestration half.
 *
 * The decisions live in `@organic-os/authorization`
 * (`membership-administration.ts`) as pure functions over values. This module is
 * what a decision costs in a real database: which rows are locked and in what order,
 * what happens in one transaction, when sessions die, and what the audit trail says
 * afterwards.
 *
 * Every mutation below follows the same seven steps, in this order, and none of them
 * is optional:
 *
 *   1. prove membership in the requested organization (`withAuthorizedOrganization`);
 *   2. `require()` the specific administration permission — before any row is read,
 *      so a caller who could never hold it learns nothing about what exists;
 *   3. lock the rows the invariants are about, in a fixed order;
 *   4. apply the policy decisions to the locked state;
 *   5. write the membership change;
 *   6. revoke the affected member's sessions **in the same transaction**;
 *   7. append the tenant audit record, also in the same transaction.
 *
 * Because 5–7 share one transaction, there is no state in which a membership changed
 * but its sessions lived on, and no state in which a mutation happened without a
 * matching audit row. A refusal at any step rolls the whole thing back, which is
 * also why no "denied" audit row is written: the transaction that would carry it is
 * the transaction being rolled back. Refusals are structured-logged by the HTTP
 * layer instead (docs/phases/PHASE-0.4.1-IMPLEMENTATION.md §9).
 */

/** A membership id arriving from a URL is routing input, like an organization id. */
const membershipIdSchema = z.uuid();

/** Where the change came from, for the audit record. Never taken from a request body. */
export interface AdministrationRequest {
  readonly source: AuditSource;
  /** Socket peer address when known. Null rather than absent, so it is always stated. */
  readonly ip: string | null;
}

/**
 * One member, as administration reports them.
 *
 * Deliberately selected: no password hash, no session data, no `is_platform_admin`.
 * `scopedClientIds` is empty for an `all_clients` membership even if scope rows
 * somehow exist, because in that mode they are not authorization and reporting them
 * would invite exactly the misreading ADR-0016 removed.
 */
export interface MemberView {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly role: MembershipRole;
  readonly clientAccessMode: ClientAccessMode;
  readonly scopedClientIds: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The client access a request asks for. Mirrors the contract, without the HTTP shape. */
export type ClientAccessRequest =
  | { readonly mode: 'all_clients' }
  | { readonly mode: 'scoped'; readonly clientIds: readonly string[] };

export interface AddMemberInput {
  readonly email: string;
  readonly role: MembershipRole;
  readonly clientAccess: ClientAccessRequest;
}

export interface ChangeMemberRoleInput {
  readonly membershipId: string;
  readonly role: MembershipRole;
}

export interface ReplaceMemberScopesInput {
  readonly membershipId: string;
  readonly clientAccess: ClientAccessRequest;
}

export interface RemoveMemberInput {
  readonly membershipId: string;
}

export interface MemberAdministrationService {
  listMembers(
    identity: AuthenticatedIdentityRef,
    organizationId: string,
  ): Promise<readonly MemberView[]>;

  addMember(
    identity: AuthenticatedIdentityRef,
    organizationId: string,
    input: AddMemberInput,
    request: AdministrationRequest,
  ): Promise<MemberView>;

  changeMemberRole(
    identity: AuthenticatedIdentityRef,
    organizationId: string,
    input: ChangeMemberRoleInput,
    request: AdministrationRequest,
  ): Promise<MemberView>;

  replaceMemberScopes(
    identity: AuthenticatedIdentityRef,
    organizationId: string,
    input: ReplaceMemberScopesInput,
    request: AdministrationRequest,
  ): Promise<MemberView>;

  removeMember(
    identity: AuthenticatedIdentityRef,
    organizationId: string,
    input: RemoveMemberInput,
    request: AdministrationRequest,
  ): Promise<void>;
}

export interface MemberAdministrationServiceOptions {
  readonly authorization: AuthorizationService;
  /**
   * The runtime pool, used for exactly one thing: resolving an email address to a
   * user id outside any tenant transaction (`user-lookup.ts`).
   */
  readonly db: Database;
}

/** A membership id this organization cannot reach reads as absent, never as forbidden. */
function membershipNotReachable(): AuthorizationError {
  return new AuthorizationError('resource_not_in_organization', { resource: 'membership' });
}

function toMemberView(row: MembershipWithUser, scopedClientIds: readonly string[]): MemberView {
  return {
    membershipId: row.membership.id,
    userId: row.user.id,
    email: row.user.email,
    name: row.user.name,
    role: row.membership.role,
    clientAccessMode: row.membership.clientAccessMode,
    scopedClientIds: row.membership.clientAccessMode === 'scoped' ? [...scopedClientIds] : [],
    createdAt: row.membership.createdAt,
    updatedAt: row.membership.updatedAt,
  };
}

/**
 * The audit `before`/`after` payload.
 *
 * Ids and policy values only. No email, no name: an append-only trail that can never
 * be corrected should carry the minimum personal data that still makes it readable,
 * and the user id resolves to both through the member list. No credential, session
 * identifier, token or CSRF value is reachable from anything in scope here.
 */
function auditState(view: MemberView): JsonObject {
  return {
    userId: view.userId,
    role: view.role,
    clientAccessMode: view.clientAccessMode,
    scopedClientIds: [...view.scopedClientIds],
  };
}

async function scopeStateOf(
  session: AuthorizedOrganizationSession,
  membership: MembershipRecord,
): Promise<ClientAccessState> {
  const rows = await session.repositories.membershipClientScopes.listByMembership(membership.id);

  return {
    mode: membership.clientAccessMode,
    clientIds: new Set(rows.map((row) => row.clientId)),
  };
}

/**
 * Applies a complete client-access statement to a membership, inside the caller's
 * transaction.
 *
 * Two properties are deliberate:
 *
 *   * **Every listed client is authorized through the acting administrator.**
 *     `requireClient('client.read', …)` composes role permission, organization
 *     ownership and the *administrator's own* client scope, so an administrator who
 *     is themselves `scoped` cannot grant a member a client they cannot reach. A
 *     client of another tenant and a client outside the admin's scope both surface
 *     as the same non-enumerating failure.
 *   * **`all_clients` deletes the scope rows.** In that mode the rows are not
 *     authorization, and leaving authorization-shaped data lying around is how the
 *     ambiguity ADR-0016 removed comes back. The state after this call always reads
 *     the same way to code that takes the collection literally.
 */
async function applyClientAccess(
  session: AuthorizedOrganizationSession,
  membership: MembershipRecord,
  requested: ClientAccessRequest,
): Promise<ClientAccessState> {
  if (requested.mode === 'scoped') {
    for (const clientId of requested.clientIds) {
      await session.requireClient('client.read', clientId);
    }
  }

  await session.repositories.membershipClientScopes.deleteAllForMembership(membership.id);

  if (membership.clientAccessMode !== requested.mode) {
    const updated = await session.repositories.memberships.updateClientAccessMode(
      membership.id,
      requested.mode,
    );

    if (updated === null) {
      throw membershipNotReachable();
    }
  }

  if (requested.mode === 'all_clients') {
    return { mode: 'all_clients', clientIds: new Set<string>() };
  }

  for (const clientId of requested.clientIds) {
    await session.repositories.membershipClientScopes.add({
      membershipId: membership.id,
      clientId,
    });
  }

  return { mode: 'scoped', clientIds: new Set(requested.clientIds) };
}

async function requireMemberView(
  session: AuthorizedOrganizationSession,
  membershipId: string,
): Promise<MemberView> {
  const row = await session.repositories.memberships.findWithUserById(membershipId);

  if (row === null) {
    throw membershipNotReachable();
  }

  const scopes = await session.repositories.membershipClientScopes.listByMembership(membershipId);

  return toMemberView(
    row,
    scopes.map((scope) => scope.clientId),
  );
}

export function createMemberAdministrationService(
  options: MemberAdministrationServiceOptions,
): MemberAdministrationService {
  const { authorization, db } = options;

  return {
    async listMembers(identity, organizationId): Promise<readonly MemberView[]> {
      return authorization.withAuthorizedOrganization(identity, organizationId, async (session) => {
        session.require('member.read');

        const rows = await session.repositories.memberships.listWithUsers();
        const scopeRows = await session.repositories.membershipClientScopes.listForOrganization();

        // One query for every scope row of the organization, grouped in memory,
        // rather than a query per membership.
        const byMembership = new Map<string, string[]>();

        for (const scope of scopeRows) {
          const existing = byMembership.get(scope.membershipId);

          if (existing === undefined) {
            byMembership.set(scope.membershipId, [scope.clientId]);
          } else {
            existing.push(scope.clientId);
          }
        }

        return rows.map((row) => toMemberView(row, byMembership.get(row.membership.id) ?? []));
      });
    },

    async addMember(identity, organizationId, input, request): Promise<MemberView> {
      // Authorize first, in a transaction that reads nothing else. Only then may an
      // address be turned into an existence answer (`user-lookup.ts`).
      await authorization.withAuthorizedOrganization(identity, organizationId, (session) => {
        session.require('member.invite_or_create');
        return Promise.resolve();
      });

      const userId = await findUserIdByEmail(db, input.email);

      if (userId === null) {
        // No account, and no invitation infrastructure exists yet. A placeholder
        // account with a default password would be strictly worse than saying so:
        // it is a credential nobody chose, on an account nobody asked for.
        throw new MembershipAdministrationError('user_not_registered');
      }

      return authorization.withAuthorizedOrganization(identity, organizationId, async (session) => {
        // Re-proven: the two transactions are separate, so nothing from the first is
        // trusted here.
        session.require('member.invite_or_create');
        assertClientAccessAllowedForRole(input.role, input.clientAccess.mode);

        // UNIQUE (organization_id, user_id) from migration 0001 is the real guard;
        // this turns the constraint violation into an answer.
        const existing = await session.repositories.memberships.findByUserId(userId);

        if (existing !== null) {
          throw new MembershipAdministrationError('membership_already_exists');
        }

        const membership = await session.repositories.memberships.create({
          userId,
          role: input.role,
          clientAccessMode: input.clientAccess.mode,
        });

        await applyClientAccess(session, membership, input.clientAccess);

        const view = await requireMemberView(session, membership.id);

        // No session revocation: the target gained access rather than losing it, and
        // authorization is re-proven per request, so any session they already hold
        // simply starts resolving this membership (§8 of the sub-phase brief).
        await session.repositories.auditLogs.append({
          action: 'membership.created',
          targetType: 'membership',
          targetId: membership.id,
          before: null,
          after: auditState(view),
          source: request.source,
          result: 'ok',
          ip: request.ip,
        });

        return view;
      });
    },

    async changeMemberRole(identity, organizationId, input, request): Promise<MemberView> {
      if (!membershipIdSchema.safeParse(input.membershipId).success) {
        throw membershipNotReachable();
      }

      return authorization.withAuthorizedOrganization(identity, organizationId, async (session) => {
        session.require('member.update_role');

        const locked = await session.repositories.memberships.lockForAdministration(
          input.membershipId,
        );
        const target = locked.find((row) => row.id === input.membershipId);

        if (target === undefined) {
          throw membershipNotReachable();
        }

        assertNotSelfMutation(session.context.membershipId, target.id);

        if (target.role === input.role) {
          // Idempotent: nothing changed, so nothing is audited and no session is
          // revoked. Recording a mutation that did not happen would make the trail
          // less trustworthy, not more.
          return requireMemberView(session, target.id);
        }

        assertAgencyAdminRemains({
          agencyAdminMembershipIds: locked
            .filter((row) => row.role === 'agency_admin')
            .map((row) => row.id),
          targetMembershipId: target.id,
          targetRemainsAgencyAdmin: input.role === 'agency_admin',
        });

        const before = await requireMemberView(session, target.id);
        const beforeAccess = await scopeStateOf(session, target);
        const normalized = normalizeClientAccessForRole(input.role, beforeAccess);

        if (normalized.mode !== beforeAccess.mode) {
          // The only transition that reaches here is all_clients → scoped for a new
          // client_viewer, and it lands on zero clients: narrowing, never widening.
          await applyClientAccess(session, target, { mode: 'scoped', clientIds: [] });
        }

        const updated = await session.repositories.memberships.updateRole(target.id, input.role);

        if (updated === null) {
          throw membershipNotReachable();
        }

        // A role change always revokes: the member's authority is different now, and
        // every session established under the old one must go. Same transaction as
        // the update above (ADR-0017).
        await session.revokeMemberSessions(updated);

        const after = await requireMemberView(session, target.id);

        await session.repositories.auditLogs.append({
          action: 'membership.role_changed',
          targetType: 'membership',
          targetId: target.id,
          before: auditState(before),
          after: auditState(after),
          source: request.source,
          result: 'ok',
          ip: request.ip,
        });

        return after;
      });
    },

    async replaceMemberScopes(identity, organizationId, input, request): Promise<MemberView> {
      if (!membershipIdSchema.safeParse(input.membershipId).success) {
        throw membershipNotReachable();
      }

      return authorization.withAuthorizedOrganization(identity, organizationId, async (session) => {
        session.require('member.update_scope');

        const target = await session.repositories.memberships.lockById(input.membershipId);

        if (target === null) {
          throw membershipNotReachable();
        }

        assertNotSelfMutation(session.context.membershipId, target.id);
        assertClientAccessAllowedForRole(target.role, input.clientAccess.mode);

        const before = await requireMemberView(session, target.id);
        const beforeAccess = await scopeStateOf(session, target);

        const afterAccess = await applyClientAccess(session, target, input.clientAccess);

        // Narrowing revokes; broadening does not. The asymmetry is deliberate and
        // documented: nothing that was permitted stops being permitted when access
        // widens, and authorization is re-read on every request either way.
        if (isClientAccessNarrowing(beforeAccess, afterAccess)) {
          await session.revokeMemberSessions(target);
        }

        const after = await requireMemberView(session, target.id);

        await session.repositories.auditLogs.append({
          action: 'membership.scope_changed',
          targetType: 'membership',
          targetId: target.id,
          before: auditState(before),
          after: auditState(after),
          source: request.source,
          result: 'ok',
          ip: request.ip,
        });

        return after;
      });
    },

    async removeMember(identity, organizationId, input, request): Promise<void> {
      if (!membershipIdSchema.safeParse(input.membershipId).success) {
        throw membershipNotReachable();
      }

      await authorization.withAuthorizedOrganization(identity, organizationId, async (session) => {
        session.require('member.remove');

        const locked = await session.repositories.memberships.lockForAdministration(
          input.membershipId,
        );
        const target = locked.find((row) => row.id === input.membershipId);

        if (target === undefined) {
          throw membershipNotReachable();
        }

        assertNotSelfMutation(session.context.membershipId, target.id);

        assertAgencyAdminRemains({
          agencyAdminMembershipIds: locked
            .filter((row) => row.role === 'agency_admin')
            .map((row) => row.id),
          targetMembershipId: target.id,
          targetRemainsAgencyAdmin: false,
        });

        // Read before the delete: `users_read_same_organization` admits the identity
        // only while the membership exists, so the audit payload has to be built now.
        const before = await requireMemberView(session, target.id);

        // Same transaction as the delete. A removed member whose sessions survived is
        // the exact state this design exists to make unreachable (ADR-0017).
        await session.revokeMemberSessions(target);

        const removed = await session.repositories.memberships.delete(target.id);

        if (!removed) {
          throw membershipNotReachable();
        }

        await session.repositories.auditLogs.append({
          action: 'membership.removed',
          targetType: 'membership',
          targetId: target.id,
          before: auditState(before),
          after: null,
          source: request.source,
          result: 'ok',
          ip: request.ip,
        });
      });
    },
  };
}
