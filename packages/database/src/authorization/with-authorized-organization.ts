import {
  authorizeOrganizationOrThrow,
  AuthorizationError,
  can,
  clientAccessAllows,
  withAuthorizedClient,
  type AuthenticatedIdentityRef,
  type AuthorizedClientContext,
  type AuthorizedOrganizationContext,
  type MembershipStore,
  type MembershipSummary,
  type Permission,
} from '@organic-os/authorization';
import { z } from 'zod';

import type { Database } from '../client.js';
import type { MembershipRecord } from '../repositories/memberships.js';
import { createTenantRepositories, type TenantRepositories } from '../repositories/index.js';
import type { TenantContext } from '../tenant/context.js';
import { runWithTenantContext } from '../tenant/transaction.js';
import { revokeAllSessionsForUserInTransaction } from './session-revocation.js';

/**
 * The canonical way to do authorized tenant work.
 *
 * Every step of the pipeline happens here, in this order, once:
 *
 *   1. verify the authenticated user's membership in the *requested* organization,
 *      against persisted rows, with no tenant context established;
 *   2. build the `AuthorizedOrganizationContext` from that row;
 *   3. open a transaction and `SET LOCAL app.current_org_id` from the **context**,
 *      never from the request;
 *   4. run the caller's work against tenant repositories;
 *   5. commit or roll back — either way the tenant setting disappears with the
 *      transaction.
 *
 * HTTP handlers do not reproduce these steps, and cannot skip one: the only way to
 * obtain repositories is to be inside step 4. If membership fails, no transaction is
 * opened and no tenant context is ever set — which is the invariant the whole
 * sub-phase exists to hold (docs/SECURITY.md §4).
 */

const clientIdSchema = z.uuid();

export interface AuthorizedOrganizationSession {
  /** Authorization-derived facts. Nothing in it came from the request. */
  readonly context: AuthorizedOrganizationContext;
  /** Tenant-scoped data, bound to `context.organizationId`. */
  readonly repositories: TenantRepositories;

  /** Non-throwing role check. Use it to shape a response, not to guard a write. */
  can(permission: Permission): boolean;

  /**
   * Role check that refuses.
   *
   * @throws {AuthorizationError} `permission_denied` — the caller is authenticated
   * and a member, but the role does not hold this permission.
   */
  require(permission: Permission): void;

  /**
   * Authorizes one client resource: role permission AND organization ownership AND
   * client scope. All three, never one.
   *
   * Ownership is proven by reading the client through the tenant repository, so it is
   * enforced twice — by the repository predicate and by Row Level Security — rather
   * than assumed from a `client_id` the caller supplied alongside an
   * `organization_id`.
   *
   * @throws {AuthorizationError} `permission_denied` when the role lacks the
   * permission; `resource_not_in_organization` when the client is absent or belongs
   * elsewhere; `client_out_of_scope` when a `scoped` membership does not list it. The
   * HTTP layer collapses the latter two into one answer so neither can be used to
   * probe for existence.
   */
  requireClient(permission: Permission, clientId: string): Promise<AuthorizedClientContext>;

  /**
   * The client ids explicitly listed for this membership.
   *
   * The raw scope list, not an authorization decision: for an `all_clients`
   * membership it is usually empty and means nothing. Authorize with
   * `requireClient`.
   */
  listScopedClientIds(): Promise<ReadonlySet<string>>;

  /**
   * Revokes every live session of the user behind `membership`, **in this
   * transaction**.
   *
   * This is what makes a security-sensitive membership change atomic: the mutation
   * and the logout it forces are one commit, so the dangerous middle state — the
   * membership changed but the old sessions survived — cannot exist (ADR-0017,
   * `session-revocation.ts`).
   *
   * The argument is a membership *record*, not a user id, and it is re-checked
   * against the authorized organization here. A membership record can only come from
   * `repositories.memberships`, which is bound to this organization and additionally
   * constrained by Row Level Security, so an administrator of organization A has no
   * way to reach this method with a member of organization B.
   *
   * `sessions` carries no organization column and no policy, so this is the one place
   * the authorized-tenant session touches a row outside the tenant boundary. It is
   * exposed as a single narrow method rather than as a raw transaction handle for
   * exactly that reason.
   *
   * @returns how many live sessions were revoked.
   */
  revokeMemberSessions(membership: MembershipRecord): Promise<number>;
}

export interface AuthorizationServiceOptions {
  readonly db: Database;
  readonly store: MembershipStore;
  /** Injectable clock. Tests pin it; production leaves it at `Date.now`. */
  readonly now?: () => Date;
}

export interface AuthorizationService {
  /**
   * The organizations the authenticated caller may choose between.
   *
   * Zero, one or many: no assumption is made that a user belongs to exactly one
   * organization, and none is auto-selected. Selection is the caller's explicit act,
   * and whatever it selects is verified again on the next request.
   */
  listOrganizations(identity: AuthenticatedIdentityRef): Promise<readonly MembershipSummary[]>;

  withAuthorizedOrganization<T>(
    identity: AuthenticatedIdentityRef,
    requestedOrganizationId: string,
    fn: (session: AuthorizedOrganizationSession) => Promise<T>,
  ): Promise<T>;
}

export function createAuthorizationService(
  options: AuthorizationServiceOptions,
): AuthorizationService {
  const { db, store } = options;
  const authorizeOptions = options.now === undefined ? {} : { now: options.now };
  const now = options.now ?? ((): Date => new Date());

  return {
    async listOrganizations(
      identity: AuthenticatedIdentityRef,
    ): Promise<readonly MembershipSummary[]> {
      return store.listMemberships(identity.userId);
    },

    async withAuthorizedOrganization<T>(
      identity: AuthenticatedIdentityRef,
      requestedOrganizationId: string,
      fn: (session: AuthorizedOrganizationSession) => Promise<T>,
    ): Promise<T> {
      // Step 1–2. Throws before any transaction is opened when membership fails.
      const context = await authorizeOrganizationOrThrow(
        store,
        identity,
        requestedOrganizationId,
        authorizeOptions,
      );

      // The tenant identity comes from the verified context. `requestedOrganizationId`
      // is not read again from here on.
      const tenant: TenantContext = {
        organizationId: context.organizationId,
        actor: {
          kind: 'user',
          userId: context.userId,
          // Recorded on audit entries. It comes from the proven membership, so an
          // entry cannot be attributed to a membership the caller was not acting
          // through (migration 0005).
          membershipId: context.membershipId,
        },
      };

      // Steps 3–5.
      return runWithTenantContext(db, tenant.organizationId, async (tx) => {
        const repositories = createTenantRepositories(tx, tenant);

        // Loaded at most once per transaction, and never reused across requests.
        let scopeCache: ReadonlySet<string> | null = null;

        const session: AuthorizedOrganizationSession = {
          context,
          repositories,

          can(permission: Permission): boolean {
            return can(context.role, permission);
          },

          require(permission: Permission): void {
            if (!can(context.role, permission)) {
              throw new AuthorizationError('permission_denied', { permission });
            }
          },

          async listScopedClientIds(): Promise<ReadonlySet<string>> {
            if (scopeCache === null) {
              const rows = await repositories.membershipClientScopes.listByMembership(
                context.membershipId,
              );
              scopeCache = new Set(rows.map((row) => row.clientId));
            }

            return scopeCache;
          },

          async requireClient(
            permission: Permission,
            clientId: string,
          ): Promise<AuthorizedClientContext> {
            // Role first: a caller that could never hold this permission learns
            // nothing about which clients exist.
            session.require(permission);

            if (!clientIdSchema.safeParse(clientId).success) {
              throw new AuthorizationError('resource_not_in_organization', {
                permission,
                resource: 'client',
              });
            }

            // Structural ownership: the repository is bound to the authorized
            // organization, and RLS enforces the same predicate independently. A
            // client of another organization reads as absent.
            const client = await repositories.clients.findById(clientId);

            if (client === null) {
              throw new AuthorizationError('resource_not_in_organization', {
                permission,
                resource: 'client',
              });
            }

            const scope = await session.listScopedClientIds();

            if (!clientAccessAllows(context.clientAccessMode, scope, clientId)) {
              throw new AuthorizationError('client_out_of_scope', {
                permission,
                resource: 'client',
              });
            }

            return withAuthorizedClient(context, clientId);
          },

          async revokeMemberSessions(membership: MembershipRecord): Promise<number> {
            // Defence in depth. The record already came from a tenant-scoped
            // repository, so this can only fail if a future caller constructs one by
            // hand — which is precisely the mistake worth failing loudly on.
            if (membership.organizationId !== context.organizationId) {
              throw new AuthorizationError('resource_not_in_organization', {
                resource: 'membership',
              });
            }

            return revokeAllSessionsForUserInTransaction(tx, membership.userId, now());
          },
        };

        return fn(session);
      });
    },
  };
}
