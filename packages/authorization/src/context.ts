import { z } from 'zod';

import { CLIENT_ACCESS_MODES, type ClientAccessMode } from './client-access.js';
import { PERMISSION_REGISTRY_VERSION } from './registry.js';
import { ORGANIZATION_ROLES, type OrganizationRole } from './roles.js';

/**
 * The three context types, and the line between them.
 *
 *   AuthenticatedIdentityRef      who the caller is. Proven by a session.
 *   AuthorizedOrganizationContext what organization the caller may act in, and as
 *                                 what. Proven by a membership row.
 *   AuthorizedClientContext       a specific client the caller may act on. Proven by
 *                                 the organization context plus ownership plus scope.
 *
 * They are never merged. An `AuthenticatedIdentityRef` carries no organization,
 * because if it did, holding a session would imply holding tenant authority — the
 * property Phase 0.3 spent a migration establishing (docs/SECURITY.md §3–§4).
 *
 * None of them carries a session token, a password hash, a CSRF token or any other
 * secret: an authorization context is passed into repositories, logged by id, and
 * kept for the life of a request.
 */

/**
 * What authorization consumes from authentication: a user id, and nothing else.
 *
 * Structurally satisfied by `AuthenticatedIdentity.user` from `@organic-os/auth`,
 * without this package depending on it. Authentication does not import authorization
 * and authorization does not import authentication.
 */
export interface AuthenticatedIdentityRef {
  readonly userId: string;
}

/**
 * The result of proving that a user holds a membership in a requested organization.
 *
 * Every field is derived from the persisted membership row. Nothing here can be
 * supplied by a caller: an `organizationId` from a URL is an input to the lookup, not
 * a field of the result, and `role` / `clientAccessMode` are read from the database
 * rather than from any request (§15 of the sub-phase brief).
 */
export interface AuthorizedOrganizationContext {
  readonly userId: string;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly role: OrganizationRole;
  readonly clientAccessMode: ClientAccessMode;
  /** Which permission matrix produced this context (see `registry.ts`). */
  readonly registryVersion: number;
  /** When membership was proven. Every request proves it again; nothing is cached. */
  readonly authorizedAt: Date;
}

/** An organization context narrowed to one client the caller may reach. */
export interface AuthorizedClientContext extends AuthorizedOrganizationContext {
  readonly clientId: string;
}

/**
 * The persisted membership facts authorization needs.
 *
 * The store returns this; `buildAuthorizedOrganizationContext` validates it. A row
 * whose role or access mode this build does not recognise is rejected rather than
 * coerced, so an unknown value can never fall through to a permissive default.
 */
export const authorizationMembershipSchema = z.object({
  membershipId: z.uuid(),
  organizationId: z.uuid(),
  userId: z.uuid(),
  role: z.enum(ORGANIZATION_ROLES),
  clientAccessMode: z.enum(CLIENT_ACCESS_MODES),
});

export type AuthorizationMembership = z.infer<typeof authorizationMembershipSchema>;

export class InvalidMembershipRecordError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid membership record: ${issues.join(', ')}`);
    this.name = 'InvalidMembershipRecordError';
    this.issues = issues;
  }
}

export interface BuildAuthorizedOrganizationContextOptions {
  /** Injectable clock; tests pin it, production leaves it at `Date.now`. */
  readonly now?: () => Date;
}

/**
 * Builds the context, failing closed.
 *
 * @throws {InvalidMembershipRecordError} when the persisted row is not something this
 * build knows how to authorize.
 */
export function buildAuthorizedOrganizationContext(
  membership: unknown,
  options: BuildAuthorizedOrganizationContextOptions = {},
): AuthorizedOrganizationContext {
  const parsed = authorizationMembershipSchema.safeParse(membership);

  if (!parsed.success) {
    throw new InvalidMembershipRecordError(
      parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.code}`,
      ),
    );
  }

  const now = options.now ?? ((): Date => new Date());

  return Object.freeze({
    userId: parsed.data.userId,
    organizationId: parsed.data.organizationId,
    membershipId: parsed.data.membershipId,
    role: parsed.data.role,
    clientAccessMode: parsed.data.clientAccessMode,
    registryVersion: PERMISSION_REGISTRY_VERSION,
    authorizedAt: now(),
  });
}

/** Narrows an organization context to a client that has already been authorized. */
export function withAuthorizedClient(
  context: AuthorizedOrganizationContext,
  clientId: string,
): AuthorizedClientContext {
  return Object.freeze({ ...context, clientId });
}
