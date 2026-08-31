import type { AuthorizationMembership } from './context.js';

/**
 * Persistence port for the authorization bootstrap.
 *
 * This package defines the interface; `@organic-os/database` implements it against
 * PostgreSQL (ADR-0011). Two methods, both keyed on the *authenticated* user id —
 * there is deliberately no "find memberships of user X" that a caller could point at
 * someone else, and no unscoped listing at all.
 *
 * Implementations must resolve memberships without establishing a tenant context:
 * tenant context is what this lookup exists to authorize, so requiring it first would
 * be circular. The PostgreSQL implementation does that with a transaction-local
 * setting and a policy narrow enough to return only the caller's own rows
 * (migration 0004).
 */

/** One membership plus the organization it is in, for the selection screen. */
export interface MembershipSummary {
  readonly membershipId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly role: string;
  readonly clientAccessMode: string;
}

export interface MembershipStore {
  /**
   * The membership `userId` holds in `organizationId`, or null when there is none.
   *
   * Called on every authorized request. It must reflect the current persisted row —
   * a removed membership, a changed role or a changed access mode must be visible on
   * the very next call — so implementations must not cache (§16–§17 of the brief).
   */
  findMembership(userId: string, organizationId: string): Promise<AuthorizationMembership | null>;

  /** Every membership `userId` holds, for organization selection. Never anyone else's. */
  listMemberships(userId: string): Promise<readonly MembershipSummary[]>;
}
