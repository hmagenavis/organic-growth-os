import type { AuthorizationMembership } from '../context.js';
import type { MembershipStore, MembershipSummary } from '../store.js';

/**
 * TEST-ONLY implementation of the authorization bootstrap port.
 *
 * It exists so role and permission behaviour can be tested without a database. It is
 * reachable only through the `@organic-os/authorization/testing` subpath and refuses
 * to construct under `NODE_ENV=production`.
 *
 * It models the port's contract, not its security: the property that makes the real
 * store safe — that a caller can resolve only its own memberships, enforced by Row
 * Level Security — cannot be modelled in a Map, and is tested against real PostgreSQL
 * in `packages/database/src/authorization/bootstrap.int.test.ts`. Nothing here is
 * evidence about isolation.
 */
export interface SeedMembershipInput extends AuthorizationMembership {
  readonly organizationName?: string;
  readonly organizationSlug?: string;
}

export class InMemoryMembershipStore implements MembershipStore {
  readonly #memberships = new Map<string, SeedMembershipInput>();

  constructor() {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error('InMemoryMembershipStore must never be used in production');
    }
  }

  static #key(userId: string, organizationId: string): string {
    return `${userId}:${organizationId}`;
  }

  add(membership: SeedMembershipInput): void {
    this.#memberships.set(
      InMemoryMembershipStore.#key(membership.userId, membership.organizationId),
      membership,
    );
  }

  remove(userId: string, organizationId: string): void {
    this.#memberships.delete(InMemoryMembershipStore.#key(userId, organizationId));
  }

  async findMembership(
    userId: string,
    organizationId: string,
  ): Promise<AuthorizationMembership | null> {
    const found = this.#memberships.get(InMemoryMembershipStore.#key(userId, organizationId));

    return Promise.resolve(
      found === undefined
        ? null
        : {
            membershipId: found.membershipId,
            organizationId: found.organizationId,
            userId: found.userId,
            role: found.role,
            clientAccessMode: found.clientAccessMode,
          },
    );
  }

  async listMemberships(userId: string): Promise<readonly MembershipSummary[]> {
    const rows = [...this.#memberships.values()]
      .filter((membership) => membership.userId === userId)
      .map((membership) => ({
        membershipId: membership.membershipId,
        organizationId: membership.organizationId,
        organizationName:
          membership.organizationName ?? `Organization ${membership.organizationId}`,
        organizationSlug: membership.organizationSlug ?? membership.organizationId,
        role: membership.role,
        clientAccessMode: membership.clientAccessMode,
      }))
      .sort((left, right) => left.organizationName.localeCompare(right.organizationName));

    return Promise.resolve(rows);
  }
}
