import { describe, expect, it } from 'vitest';

import { authorizeOrganization, authorizeOrganizationOrThrow } from './authorize.js';
import { InvalidMembershipRecordError } from './context.js';
import { AuthorizationError } from './errors.js';
import { PERMISSION_REGISTRY_VERSION } from './registry.js';
import type { MembershipStore } from './store.js';
import { InMemoryMembershipStore } from './testing/in-memory-store.js';

/**
 * Turning an authenticated identity into an authorized organization context.
 *
 * These are the policy-level assertions; the same properties are proven against real
 * PostgreSQL and Row Level Security in
 * `packages/database/src/authorization/bootstrap.int.test.ts`.
 */

const ORG_A = '018f9e1a-0000-7000-8000-0000000000a0';
const ORG_B = '018f9e1a-0000-7000-8000-0000000000b0';
const USER_A = '018f9e1a-0000-7000-8000-0000000000a1';
const USER_B = '018f9e1a-0000-7000-8000-0000000000b1';
const MEMBERSHIP_A = '018f9e1a-0000-7000-8000-0000000000a2';
const MEMBERSHIP_B = '018f9e1a-0000-7000-8000-0000000000b2';

function storeWithBothOrganizations(): InMemoryMembershipStore {
  const store = new InMemoryMembershipStore();

  store.add({
    membershipId: MEMBERSHIP_A,
    organizationId: ORG_A,
    userId: USER_A,
    role: 'agency_admin',
    clientAccessMode: 'all_clients',
  });
  store.add({
    membershipId: MEMBERSHIP_B,
    organizationId: ORG_B,
    userId: USER_B,
    role: 'client_viewer',
    clientAccessMode: 'scoped',
  });

  return store;
}

describe('successful authorization', () => {
  it('builds a context entirely out of the persisted membership', async () => {
    const store = storeWithBothOrganizations();
    const at = new Date('2026-08-31T10:00:00.000Z');

    const outcome = await authorizeOrganization(store, { userId: USER_A }, ORG_A, {
      now: () => at,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }

    expect(outcome.context).toEqual({
      userId: USER_A,
      organizationId: ORG_A,
      membershipId: MEMBERSHIP_A,
      role: 'agency_admin',
      clientAccessMode: 'all_clients',
      registryVersion: PERMISSION_REGISTRY_VERSION,
      authorizedAt: at,
    });
  });

  it('returns a frozen context', async () => {
    const store = storeWithBothOrganizations();
    const context = await authorizeOrganizationOrThrow(store, { userId: USER_A }, ORG_A);

    expect(Object.isFrozen(context)).toBe(true);
  });
});

describe('refusals', () => {
  it('refuses an organization the caller is not a member of', async () => {
    const store = storeWithBothOrganizations();

    const outcome = await authorizeOrganization(store, { userId: USER_A }, ORG_B);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.error.failure).toBe('no_membership');
  });

  it('refuses a forged organization id without querying', async () => {
    let queried = 0;
    const store: MembershipStore = {
      findMembership: async () => {
        queried += 1;
        return Promise.resolve(null);
      },
      listMemberships: async () => Promise.resolve([]),
    };

    for (const forged of ['', 'not-a-uuid', '../../etc/passwd', "' OR 1=1 --", '0']) {
      const outcome = await authorizeOrganization(store, { userId: USER_A }, forged);

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.failure).toBe('malformed_organization_id');
      }
    }

    expect(queried).toBe(0);
  });

  it('refuses a well-formed organization id that exists for nobody', async () => {
    const store = storeWithBothOrganizations();

    const outcome = await authorizeOrganization(
      store,
      { userId: USER_A },
      '00000000-0000-4000-8000-000000000000',
    );

    expect(outcome.ok).toBe(false);
  });

  it('refuses a store row that names a different user or organization', async () => {
    // Defence in depth: even if the persistence layer returned the wrong row, the
    // context is never built from it.
    const wrongRow: MembershipStore = {
      findMembership: async () =>
        Promise.resolve({
          membershipId: MEMBERSHIP_B,
          organizationId: ORG_B,
          userId: USER_B,
          role: 'agency_admin' as const,
          clientAccessMode: 'all_clients' as const,
        }),
      listMemberships: async () => Promise.resolve([]),
    };

    const outcome = await authorizeOrganization(wrongRow, { userId: USER_A }, ORG_A);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.failure).toBe('no_membership');
    }
  });

  it('rejects a membership row whose role this build does not know', async () => {
    const unknownRole: MembershipStore = {
      findMembership: async () =>
        Promise.resolve({
          membershipId: MEMBERSHIP_A,
          organizationId: ORG_A,
          userId: USER_A,
          // A value the enum does not contain: refused, never coerced.
          role: 'super_admin',
          clientAccessMode: 'all_clients',
        } as never),
      listMemberships: async () => Promise.resolve([]),
    };

    await expect(
      authorizeOrganization(unknownRole, { userId: USER_A }, ORG_A),
    ).rejects.toBeInstanceOf(InvalidMembershipRecordError);
  });

  it('throws an AuthorizationError from the throwing form', async () => {
    const store = storeWithBothOrganizations();

    await expect(
      authorizeOrganizationOrThrow(store, { userId: USER_A }, ORG_B),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('no authorization cache', () => {
  it('re-reads the membership on every call', async () => {
    let calls = 0;
    const store = storeWithBothOrganizations();
    const counting: MembershipStore = {
      findMembership: async (userId, organizationId) => {
        calls += 1;
        return store.findMembership(userId, organizationId);
      },
      listMemberships: async (userId) => store.listMemberships(userId),
    };

    await authorizeOrganization(counting, { userId: USER_A }, ORG_A);
    await authorizeOrganization(counting, { userId: USER_A }, ORG_A);
    await authorizeOrganization(counting, { userId: USER_A }, ORG_A);

    expect(calls).toBe(3);
  });

  it('observes a membership removal immediately', async () => {
    const store = storeWithBothOrganizations();

    expect((await authorizeOrganization(store, { userId: USER_A }, ORG_A)).ok).toBe(true);

    store.remove(USER_A, ORG_A);

    expect((await authorizeOrganization(store, { userId: USER_A }, ORG_A)).ok).toBe(false);
  });

  it('observes a role change immediately', async () => {
    const store = storeWithBothOrganizations();

    store.add({
      membershipId: MEMBERSHIP_A,
      organizationId: ORG_A,
      userId: USER_A,
      role: 'analyst',
      clientAccessMode: 'scoped',
    });

    const outcome = await authorizeOrganization(store, { userId: USER_A }, ORG_A);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.context.role).toBe('analyst');
      expect(outcome.context.clientAccessMode).toBe('scoped');
    }
  });
});

describe('organization selection', () => {
  it('supports zero, one and many organizations', async () => {
    const store = new InMemoryMembershipStore();

    expect(await store.listMemberships(USER_A)).toEqual([]);

    store.add({
      membershipId: MEMBERSHIP_A,
      organizationId: ORG_A,
      userId: USER_A,
      role: 'agency_admin',
      clientAccessMode: 'all_clients',
      organizationName: 'Alpha',
    });
    expect(await store.listMemberships(USER_A)).toHaveLength(1);

    store.add({
      membershipId: MEMBERSHIP_B,
      organizationId: ORG_B,
      userId: USER_A,
      role: 'analyst',
      clientAccessMode: 'all_clients',
      organizationName: 'Beta',
    });

    const listed = await store.listMemberships(USER_A);
    expect(listed.map((row) => row.organizationName)).toEqual(['Alpha', 'Beta']);
  });

  it('never auto-selects: each organization must be authorized explicitly', async () => {
    const store = new InMemoryMembershipStore();
    store.add({
      membershipId: MEMBERSHIP_A,
      organizationId: ORG_A,
      userId: USER_A,
      role: 'agency_admin',
      clientAccessMode: 'all_clients',
    });

    // Being a member of exactly one organization does not authorize a different one.
    expect((await authorizeOrganization(store, { userId: USER_A }, ORG_B)).ok).toBe(false);
  });
});
