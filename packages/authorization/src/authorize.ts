import { z } from 'zod';

import {
  buildAuthorizedOrganizationContext,
  type AuthenticatedIdentityRef,
  type AuthorizedOrganizationContext,
} from './context.js';
import { AuthorizationError } from './errors.js';
import type { MembershipStore } from './store.js';

/**
 * The one place an `AuthenticatedIdentityRef` becomes an
 * `AuthorizedOrganizationContext`.
 *
 * The requested organization identifier is *routing input*. It arrives from a URL, a
 * header or a form; it is never authorization by itself. What makes the resulting
 * context trustworthy is that every field of it comes from the membership row found
 * for `(authenticated user, requested organization)` — a row the caller cannot
 * write, and a lookup that returns nothing when the caller is not a member.
 *
 * Consequences worth stating, because each is a test:
 *
 *   * a forged or guessed organization id resolves to no membership and is refused;
 *   * a valid organization the caller is not a member of is refused identically;
 *   * a membership id supplied by a caller is never consulted — the lookup is by
 *     (user, organization), so there is nothing to forge;
 *   * a role or client access mode supplied by a caller is ignored, because neither
 *     is an input to this function.
 *
 * Nothing is cached. Membership is proven again on every request, so a removed
 * membership or a changed role takes effect on the next one.
 */

const organizationIdSchema = z.uuid();

export interface AuthorizeOrganizationOptions {
  readonly now?: () => Date;
}

export type AuthorizationOutcome =
  | { readonly ok: true; readonly context: AuthorizedOrganizationContext }
  | { readonly ok: false; readonly error: AuthorizationError };

/**
 * Resolves and verifies membership. Returns an outcome rather than throwing, so
 * callers that want the failure category (logging, metrics) do not need a try/catch;
 * `authorizeOrganizationOrThrow` is the throwing form.
 */
export async function authorizeOrganization(
  store: MembershipStore,
  identity: AuthenticatedIdentityRef,
  requestedOrganizationId: string,
  options: AuthorizeOrganizationOptions = {},
): Promise<AuthorizationOutcome> {
  // A malformed identifier is refused before it reaches the database, so a bad path
  // parameter cannot become a query error that behaves differently from a miss.
  if (!organizationIdSchema.safeParse(requestedOrganizationId).success) {
    return { ok: false, error: new AuthorizationError('malformed_organization_id') };
  }

  const membership = await store.findMembership(identity.userId, requestedOrganizationId);

  if (membership === null) {
    return { ok: false, error: new AuthorizationError('no_membership') };
  }

  // Defence in depth against a store that returns the wrong row: the context is only
  // ever built from a membership that names this user and this organization.
  if (
    membership.userId !== identity.userId ||
    membership.organizationId !== requestedOrganizationId
  ) {
    return { ok: false, error: new AuthorizationError('no_membership') };
  }

  const contextOptions = options.now === undefined ? {} : { now: options.now };

  return { ok: true, context: buildAuthorizedOrganizationContext(membership, contextOptions) };
}

/** @throws {AuthorizationError} when membership cannot be proven. */
export async function authorizeOrganizationOrThrow(
  store: MembershipStore,
  identity: AuthenticatedIdentityRef,
  requestedOrganizationId: string,
  options: AuthorizeOrganizationOptions = {},
): Promise<AuthorizedOrganizationContext> {
  const outcome = await authorizeOrganization(store, identity, requestedOrganizationId, options);

  if (!outcome.ok) {
    throw outcome.error;
  }

  return outcome.context;
}
