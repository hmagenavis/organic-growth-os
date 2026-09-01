import {
  isAuthorizationError,
  isMembershipAdministrationError,
  type AuthenticatedIdentityRef,
} from '@organic-os/authorization';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createMembershipStore } from '../authorization/membership-store.js';
import { createAuthorizationService } from '../authorization/with-authorized-organization.js';
import { createDatabase, type DatabaseHandle } from '../client.js';
import { provisionMembership, provisionOrganization, provisionUser } from '../provisioning.js';
import type { TenantContext } from '../tenant/context.js';
import { withTenantTransaction } from '../tenant/with-tenant-transaction.js';
import { createTestDatabase, type TestDatabase } from '../testing/database.js';
import {
  createMemberAdministrationService,
  type AdministrationRequest,
  type MemberAdministrationService,
} from './membership-administration.js';

/**
 * The concurrency-sensitive half of member administration.
 *
 * Its own file because it needs several connections at once: the shared runtime
 * handle in `testing/database.ts` is deliberately capped at one, so that the
 * pool-leakage probe means something. A separate pool is opened here against the same
 * runtime role, with the same Row Level Security and the same grants.
 *
 * The invariant under test is the one a sequential test cannot reach:
 *
 *   > An organization with active membership administration may never commit a state
 *   > with zero agency_admin memberships.
 *
 * The failure it exists to prevent is the classic check-then-act race. Two
 * administrators, A and B. A demotes B; B demotes A. Both transactions read "two
 * admins, demoting one leaves one" from their own snapshot, both commit, and the
 * organization is left with nobody who can administer it — a tenant that can only be
 * repaired with direct SQL. `lockForAdministration` is what makes that impossible:
 * every mutation locks every `agency_admin` row of the organization plus its target,
 * in `id` order, so the second transaction blocks and then re-reads the first one's
 * committed effect instead of its own stale snapshot.
 */

const REQUEST: AdministrationRequest = { source: 'api', ip: '198.51.100.20' };

let database: TestDatabase;
/** Several connections, so two administrators can genuinely act at the same time. */
let concurrent: DatabaseHandle;
let members: MemberAdministrationService;

interface Actor {
  userId: string;
  membershipId: string;
}

let organizationId: string;
let adminA: Actor;
let adminB: Actor;
let adminC: Actor;
let bystander: Actor;

function identity(actor: Actor): AuthenticatedIdentityRef {
  return { userId: actor.userId };
}

interface Outcome {
  readonly ok: boolean;
  readonly failure: string | null;
}

async function attempt(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    await run();
    return { ok: true, failure: null };
  } catch (error: unknown) {
    if (isMembershipAdministrationError(error) || isAuthorizationError(error)) {
      return { ok: false, failure: error.failure };
    }

    // A deadlock or serialization error would also be an acceptable refusal, but it
    // must not be silent, so it is reported rather than swallowed.
    return { ok: false, failure: error instanceof Error ? error.message : 'unknown error' };
  }
}

/**
 * `memberships` is tenant-scoped, so a bare statement with no `app.current_org_id`
 * reads zero rows — the isolation working, not the organization being empty. Every
 * fixture read and write here therefore goes through a tenant transaction, exactly as
 * the application does. The actor is `system`: these are fixture operations, not
 * something a user did, and they must keep working after a test removes a membership.
 */
function fixtureTenant(): TenantContext {
  return { organizationId, actor: { kind: 'system' } };
}

async function agencyAdminCount(): Promise<number> {
  return withTenantTransaction(
    concurrent.db,
    fixtureTenant(),
    async (r) => (await r.memberships.list()).filter((row) => row.role === 'agency_admin').length,
  );
}

/** Restores the three administrators, without going through the service under test. */
async function resetAdministrators(): Promise<void> {
  await withTenantTransaction(concurrent.db, fixtureTenant(), async (r) => {
    for (const membershipId of [adminA.membershipId, adminB.membershipId, adminC.membershipId]) {
      await r.memberships.updateRole(membershipId, 'agency_admin');
    }

    await r.memberships.updateRole(bystander.membershipId, 'analyst');
  });
}

/** The membership id a restored user now holds, read under the tenant context. */
async function membershipIdOf(userId: string): Promise<string | undefined> {
  return withTenantTransaction(
    concurrent.db,
    fixtureTenant(),
    async (r) => (await r.memberships.findByUserId(userId))?.id,
  );
}

beforeAll(async () => {
  database = await createTestDatabase(inject('postgresAdminUri'), 'organic_os_member_race_test');

  const provisioner = database.provisioner.db;

  const organization = await provisionOrganization(provisioner, {
    name: 'Member Race',
    slug: 'member-race',
  });
  organizationId = organization.id;

  async function member(handle: string, role: 'agency_admin' | 'analyst'): Promise<Actor> {
    const user = await provisionUser(provisioner, {
      email: `${handle}@example.test`,
      name: handle,
    });
    const membership = await provisionMembership(provisioner, {
      organizationId,
      userId: user.id,
      role,
      clientAccessMode: 'all_clients',
    });

    return { userId: user.id, membershipId: membership.id };
  }

  adminA = await member('race-admin-a', 'agency_admin');
  adminB = await member('race-admin-b', 'agency_admin');
  adminC = await member('race-admin-c', 'agency_admin');
  bystander = await member('race-bystander', 'analyst');

  concurrent = createDatabase({
    connectionString: database.runtimeUrl,
    maxConnections: 8,
    applicationName: 'organic-os-test-race',
  });

  members = createMemberAdministrationService({
    authorization: createAuthorizationService({
      db: concurrent.db,
      store: createMembershipStore(concurrent.db),
    }),
    db: concurrent.db,
  });
}, 240_000);

afterAll(async () => {
  await concurrent?.close();
  await database?.close();
});

beforeEach(async () => {
  await resetAdministrators();
});

describe('two administrators demoting each other', () => {
  it('leaves at least one agency admin, whichever wins', async () => {
    // Down to two admins first, so a single successful demotion is decisive.
    await members.changeMemberRole(
      identity(adminA),
      organizationId,
      { membershipId: adminC.membershipId, role: 'analyst' },
      REQUEST,
    );

    expect(await agencyAdminCount()).toBe(2);

    const [first, second] = await Promise.all([
      attempt(() =>
        members.changeMemberRole(
          identity(adminA),
          organizationId,
          { membershipId: adminB.membershipId, role: 'analyst' },
          REQUEST,
        ),
      ),
      attempt(() =>
        members.changeMemberRole(
          identity(adminB),
          organizationId,
          { membershipId: adminA.membershipId, role: 'analyst' },
          REQUEST,
        ),
      ),
    ]);

    // Exactly one may succeed. Both succeeding is the bug this file exists for.
    const succeeded = [first, second].filter((outcome) => outcome.ok);
    expect(succeeded).toHaveLength(1);

    // Which refusal the loser gets depends on how far it had travelled when the
    // winner committed: `last_agency_admin` if it was already inside the transaction
    // holding the lock, `permission_denied` if the winner's demotion landed before it
    // re-proved its own membership. Both are correct, and both preserve the
    // invariant; what must never appear is a second success.
    const refused = [first, second].find((outcome) => !outcome.ok);
    expect(['last_agency_admin', 'permission_denied']).toContain(refused?.failure);

    expect(await agencyAdminCount()).toBe(1);
  });

  it('holds when three administrators demote each other at once', async () => {
    expect(await agencyAdminCount()).toBe(3);

    const outcomes = await Promise.all([
      attempt(() =>
        members.changeMemberRole(
          identity(adminA),
          organizationId,
          { membershipId: adminB.membershipId, role: 'analyst' },
          REQUEST,
        ),
      ),
      attempt(() =>
        members.changeMemberRole(
          identity(adminB),
          organizationId,
          { membershipId: adminC.membershipId, role: 'analyst' },
          REQUEST,
        ),
      ),
      attempt(() =>
        members.changeMemberRole(
          identity(adminC),
          organizationId,
          { membershipId: adminA.membershipId, role: 'analyst' },
          REQUEST,
        ),
      ),
    ]);

    // Whatever interleaving PostgreSQL chose, the organization is still administrable.
    expect(await agencyAdminCount()).toBeGreaterThanOrEqual(1);

    // Every refusal is a policy refusal, never a deadlock or a serialization error:
    // the fixed `ORDER BY id` in `lockForAdministration` is what rules those out.
    for (const outcome of outcomes.filter((value) => !value.ok)) {
      expect(['last_agency_admin', 'permission_denied', 'no_membership']).toContain(
        outcome.failure,
      );
    }
  });
});

describe('two administrators removing each other', () => {
  it('leaves at least one agency admin', async () => {
    await members.changeMemberRole(
      identity(adminA),
      organizationId,
      { membershipId: adminC.membershipId, role: 'analyst' },
      REQUEST,
    );

    const [first, second] = await Promise.all([
      attempt(() =>
        members.removeMember(
          identity(adminA),
          organizationId,
          { membershipId: adminB.membershipId },
          REQUEST,
        ),
      ),
      attempt(() =>
        members.removeMember(
          identity(adminB),
          organizationId,
          { membershipId: adminA.membershipId },
          REQUEST,
        ),
      ),
    ]);

    expect([first, second].filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(await agencyAdminCount()).toBe(1);

    const refused = [first, second].find((outcome) => !outcome.ok);
    expect(['last_agency_admin', 'permission_denied', 'no_membership']).toContain(refused?.failure);

    // Put the removed administrator back for the remaining tests. `provisionMembership`
    // establishes the tenant context in its own transaction, so nothing is needed here.
    const removed = first.ok ? adminB : adminA;
    await provisionMembership(database.provisioner.db, {
      organizationId,
      userId: removed.userId,
      role: 'agency_admin',
      clientAccessMode: 'all_clients',
    });

    const restoredId = await membershipIdOf(removed.userId);
    expect(restoredId).toBeDefined();

    if (removed === adminA) {
      adminA = { ...adminA, membershipId: restoredId ?? adminA.membershipId };
    } else {
      adminB = { ...adminB, membershipId: restoredId ?? adminB.membershipId };
    }
  });
});

describe('a demotion racing a removal', () => {
  it('never commits a state with no agency admin', async () => {
    await members.changeMemberRole(
      identity(adminA),
      organizationId,
      { membershipId: adminC.membershipId, role: 'analyst' },
      REQUEST,
    );

    const [demotion, removal] = await Promise.all([
      attempt(() =>
        members.changeMemberRole(
          identity(adminA),
          organizationId,
          { membershipId: adminB.membershipId, role: 'analyst' },
          REQUEST,
        ),
      ),
      attempt(() =>
        members.removeMember(
          identity(adminB),
          organizationId,
          { membershipId: adminA.membershipId },
          REQUEST,
        ),
      ),
    ]);

    expect([demotion, removal].filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(await agencyAdminCount()).toBe(1);

    if (removal.ok) {
      await provisionMembership(database.provisioner.db, {
        organizationId,
        userId: adminA.userId,
        role: 'agency_admin',
        clientAccessMode: 'all_clients',
      });

      adminA = {
        ...adminA,
        membershipId: (await membershipIdOf(adminA.userId)) ?? adminA.membershipId,
      };
    }
  });
});

describe('promotions are never blocked by the invariant', () => {
  it('lets several administrators promote different members at once', async () => {
    const outcomes = await Promise.all([
      attempt(() =>
        members.changeMemberRole(
          identity(adminA),
          organizationId,
          { membershipId: bystander.membershipId, role: 'seo_manager' },
          REQUEST,
        ),
      ),
      attempt(() =>
        members.changeMemberRole(
          identity(adminB),
          organizationId,
          { membershipId: adminC.membershipId, role: 'agency_admin' },
          REQUEST,
        ),
      ),
    ]);

    // Both are safe changes; serialising them must not turn either into a failure.
    for (const outcome of outcomes) {
      expect(outcome.failure).toBeNull();
    }

    expect(await agencyAdminCount()).toBeGreaterThanOrEqual(1);
  });
});
