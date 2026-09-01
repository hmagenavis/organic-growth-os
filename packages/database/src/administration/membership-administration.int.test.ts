import {
  generateSessionToken,
  hashSessionToken,
  type AuthStore,
  type SessionRecord,
} from '@organic-os/auth';
import {
  isAuthorizationError,
  isMembershipAdministrationError,
  type AuthenticatedIdentityRef,
} from '@organic-os/authorization';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createAuthStore } from '../auth/store.js';
import { createMembershipStore } from '../authorization/membership-store.js';
import {
  createAuthorizationService,
  type AuthorizationService,
  type AuthorizedOrganizationSession,
} from '../authorization/with-authorized-organization.js';
import { provisionMembership, provisionOrganization, provisionUser } from '../provisioning.js';
import type { AuditLogRecord } from '../repositories/audit-logs.js';
import type { TenantContext } from '../tenant/context.js';
import { withTenantTransaction } from '../tenant/with-tenant-transaction.js';
import { createTestDatabase, type TestDatabase } from '../testing/database.js';
import {
  createMemberAdministrationService,
  type AdministrationRequest,
  type MemberAdministrationService,
} from './membership-administration.js';

/**
 * Member administration against real PostgreSQL.
 *
 * Everything here runs through the same code a deployment runs, as the runtime role,
 * with Row Level Security on and the real grants. Concurrency has its own file
 * (`membership-concurrency.int.test.ts`) because it needs more than one connection;
 * this one covers what a single administrator can and cannot do, what happens to the
 * affected member's sessions, and what the audit trail says afterwards.
 */

const REQUEST: AdministrationRequest = { source: 'api', ip: '198.51.100.10' };

let database: TestDatabase;
let authorization: AuthorizationService;
let members: MemberAdministrationService;
let authStore: AuthStore;

interface Actor {
  userId: string;
  membershipId: string;
  email: string;
}

interface Fixture {
  orgA: string;
  orgB: string;
  orgC: string;
  clientA1: string;
  clientA2: string;
  clientB1: string;
  /** Two agency admins, so one of them can be demoted. */
  adminOne: Actor;
  adminTwo: Actor;
  manager: Actor;
  viewer: Actor;
  analyst: Actor;
  /** agency_admin of organization B, for cross-tenant probes. */
  foreignAdmin: Actor;
  /** The only agency_admin of organization C. */
  soloAdmin: Actor;
  helper: Actor;
  /** A real account holding no membership anywhere. */
  unattachedEmail: string;
  unattachedUserId: string;
}

let fixture: Fixture;

function identity(actor: Actor): AuthenticatedIdentityRef {
  return { userId: actor.userId };
}

function tenantOf(organizationId: string, actor: Actor): TenantContext {
  return { organizationId, actor: { kind: 'user', userId: actor.userId } };
}

async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error: unknown) {
    if (isMembershipAdministrationError(error) || isAuthorizationError(error)) {
      return error.failure;
    }

    throw error;
  }

  return '(no failure)';
}

async function openSession(userId: string): Promise<SessionRecord> {
  const now = new Date();

  return authStore.createSession({
    userId,
    tokenHash: hashSessionToken(generateSessionToken()),
    expiresAt: new Date(now.getTime() + 3_600_000),
    now,
  });
}

async function liveSessionCount(userId: string): Promise<number> {
  const result = await database.runtime.db.execute<{ live: string }>(
    sql`SELECT count(*)::text AS live FROM sessions WHERE user_id = ${userId} AND revoked_at IS NULL`,
  );

  return Number(result.rows[0]?.live ?? '-1');
}

async function auditRows(organizationId: string, actor: Actor): Promise<AuditLogRecord[]> {
  return withTenantTransaction(database.runtime.db, tenantOf(organizationId, actor), async (r) =>
    r.auditLogs.list(200),
  );
}

async function roleOf(organizationId: string, actor: Actor, membershipId: string): Promise<string> {
  return withTenantTransaction(database.runtime.db, tenantOf(organizationId, actor), async (r) => {
    const membership = await r.memberships.findById(membershipId);
    return membership?.role ?? '(absent)';
  });
}

async function scopeOf(
  organizationId: string,
  actor: Actor,
  membershipId: string,
): Promise<string[]> {
  return withTenantTransaction(database.runtime.db, tenantOf(organizationId, actor), async (r) => {
    const rows = await r.membershipClientScopes.listByMembership(membershipId);
    return rows.map((row) => row.clientId).sort();
  });
}

beforeAll(async () => {
  database = await createTestDatabase(inject('postgresAdminUri'), 'organic_os_member_admin_test');

  const provisioner = database.provisioner.db;

  const organizationA = await provisionOrganization(provisioner, {
    name: 'Member Admin A',
    slug: 'member-admin-a',
  });
  const organizationB = await provisionOrganization(provisioner, {
    name: 'Member Admin B',
    slug: 'member-admin-b',
  });
  const organizationC = await provisionOrganization(provisioner, {
    name: 'Member Admin C',
    slug: 'member-admin-c',
  });

  async function member(
    organizationId: string,
    handle: string,
    role: 'agency_admin' | 'seo_manager' | 'analyst' | 'client_viewer',
    clientAccessMode: 'all_clients' | 'scoped',
  ): Promise<Actor> {
    const user = await provisionUser(provisioner, {
      email: `${handle}@example.test`,
      name: handle,
    });

    const membership = await provisionMembership(provisioner, {
      organizationId,
      userId: user.id,
      role,
      clientAccessMode,
    });

    return { userId: user.id, membershipId: membership.id, email: user.email };
  }

  const adminOne = await member(organizationA.id, 'ma-admin-one', 'agency_admin', 'all_clients');
  const adminTwo = await member(organizationA.id, 'ma-admin-two', 'agency_admin', 'all_clients');
  const manager = await member(organizationA.id, 'ma-manager', 'seo_manager', 'all_clients');
  const viewer = await member(organizationA.id, 'ma-viewer', 'client_viewer', 'scoped');
  const analystActor = await member(organizationA.id, 'ma-analyst', 'analyst', 'scoped');
  const foreignAdmin = await member(organizationB.id, 'ma-foreign', 'agency_admin', 'all_clients');
  const soloAdmin = await member(organizationC.id, 'ma-solo', 'agency_admin', 'all_clients');
  const helper = await member(organizationC.id, 'ma-helper', 'analyst', 'all_clients');

  const unattached = await provisionUser(provisioner, {
    email: 'ma-unattached@example.test',
    name: 'Unattached',
  });

  // Clients are created through ordinary tenant repositories, exactly as the
  // application would.
  const { clientA1, clientA2 } = await withTenantTransaction(
    database.runtime.db,
    tenantOf(organizationA.id, adminOne),
    async (r) => {
      const first = await r.clients.create({ name: 'Client A1' });
      const second = await r.clients.create({ name: 'Client A2' });
      return { clientA1: first.id, clientA2: second.id };
    },
  );

  const clientB1 = await withTenantTransaction(
    database.runtime.db,
    tenantOf(organizationB.id, foreignAdmin),
    async (r) => (await r.clients.create({ name: 'Client B1' })).id,
  );

  await withTenantTransaction(
    database.runtime.db,
    tenantOf(organizationA.id, adminOne),
    async (r) => {
      await r.membershipClientScopes.add({ membershipId: viewer.membershipId, clientId: clientA1 });
      await r.membershipClientScopes.add({
        membershipId: analystActor.membershipId,
        clientId: clientA1,
      });
      await r.membershipClientScopes.add({
        membershipId: analystActor.membershipId,
        clientId: clientA2,
      });
    },
  );

  authorization = createAuthorizationService({
    db: database.runtime.db,
    store: createMembershipStore(database.runtime.db),
  });
  members = createMemberAdministrationService({ authorization, db: database.runtime.db });
  authStore = createAuthStore(database.runtime.db);

  fixture = {
    orgA: organizationA.id,
    orgB: organizationB.id,
    orgC: organizationC.id,
    clientA1,
    clientA2,
    clientB1,
    adminOne,
    adminTwo,
    manager,
    viewer,
    analyst: analystActor,
    foreignAdmin,
    soloAdmin,
    helper,
    unattachedEmail: unattached.email,
    unattachedUserId: unattached.id,
  };
}, 240_000);

afterAll(async () => {
  await database?.close();
});

describe('reading the member list', () => {
  it('returns every member of the organization with its access', async () => {
    const listed = await members.listMembers(identity(fixture.adminOne), fixture.orgA);

    expect(listed.map((row) => row.email).sort()).toEqual(
      [
        fixture.adminOne.email,
        fixture.adminTwo.email,
        fixture.manager.email,
        fixture.viewer.email,
        fixture.analyst.email,
      ].sort(),
    );

    const viewer = listed.find((row) => row.membershipId === fixture.viewer.membershipId);
    expect(viewer?.role).toBe('client_viewer');
    expect(viewer?.clientAccessMode).toBe('scoped');
    expect(viewer?.scopedClientIds).toEqual([fixture.clientA1]);
  });

  it('reports no scoped clients for an all_clients membership', async () => {
    const listed = await members.listMembers(identity(fixture.adminOne), fixture.orgA);
    const manager = listed.find((row) => row.membershipId === fixture.manager.membershipId);

    expect(manager?.clientAccessMode).toBe('all_clients');
    expect(manager?.scopedClientIds).toEqual([]);
  });

  it('exposes no authentication or platform field', async () => {
    const listed = await members.listMembers(identity(fixture.adminOne), fixture.orgA);

    for (const row of listed) {
      expect(Object.keys(row).sort()).toEqual(
        [
          'clientAccessMode',
          'createdAt',
          'email',
          'membershipId',
          'name',
          'role',
          'scopedClientIds',
          'updatedAt',
          'userId',
        ].sort(),
      );
    }
  });

  it('refuses a non-admin member', async () => {
    expect(
      await failureOf(() => members.listMembers(identity(fixture.manager), fixture.orgA)),
    ).toBe('permission_denied');
  });

  it('refuses an administrator of another organization', async () => {
    expect(
      await failureOf(() => members.listMembers(identity(fixture.foreignAdmin), fixture.orgA)),
    ).toBe('no_membership');
  });

  it('never leaks another organization members', async () => {
    const listed = await members.listMembers(identity(fixture.foreignAdmin), fixture.orgB);

    expect(listed.map((row) => row.email)).toEqual([fixture.foreignAdmin.email]);
  });
});

describe('attaching a member', () => {
  it('refuses a non-admin before any address is resolved', async () => {
    expect(
      await failureOf(() =>
        members.addMember(
          identity(fixture.manager),
          fixture.orgA,
          {
            email: fixture.unattachedEmail,
            role: 'analyst',
            clientAccess: { mode: 'all_clients' },
          },
          REQUEST,
        ),
      ),
    ).toBe('permission_denied');
  });

  it('reports an address with no account rather than creating one', async () => {
    expect(
      await failureOf(() =>
        members.addMember(
          identity(fixture.adminOne),
          fixture.orgA,
          { email: 'nobody@example.test', role: 'analyst', clientAccess: { mode: 'all_clients' } },
          REQUEST,
        ),
      ),
    ).toBe('user_not_registered');

    // Nothing was created for that address.
    const users = await database.runtime.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM users WHERE email = 'nobody@example.test'`,
    );
    expect(users.rows[0]?.count).toBe('0');
  });

  it('attaches an existing account and writes exactly one audit record', async () => {
    const before = await auditRows(fixture.orgA, fixture.adminOne);

    const created = await members.addMember(
      identity(fixture.adminOne),
      fixture.orgA,
      {
        email: fixture.unattachedEmail,
        role: 'analyst',
        clientAccess: { mode: 'scoped', clientIds: [fixture.clientA1] },
      },
      REQUEST,
    );

    expect(created.userId).toBe(fixture.unattachedUserId);
    expect(created.role).toBe('analyst');
    expect(created.clientAccessMode).toBe('scoped');
    expect(created.scopedClientIds).toEqual([fixture.clientA1]);

    const after = await auditRows(fixture.orgA, fixture.adminOne);
    expect(after.length).toBe(before.length + 1);

    const entry = after[0];
    expect(entry?.action).toBe('membership.created');
    expect(entry?.targetType).toBe('membership');
    expect(entry?.targetId).toBe(created.membershipId);
    expect(entry?.organizationId).toBe(fixture.orgA);
    expect(entry?.actorId).toBe(fixture.adminOne.userId);
    expect(entry?.actorMembershipId).toBe(fixture.adminOne.membershipId);
    expect(entry?.result).toBe('ok');
    expect(entry?.source).toBe('api');
    expect(entry?.before).toBeNull();
    expect(entry?.after).toEqual({
      userId: fixture.unattachedUserId,
      role: 'analyst',
      clientAccessMode: 'scoped',
      scopedClientIds: [fixture.clientA1],
    });
  });

  it('refuses a second membership for the same user', async () => {
    expect(
      await failureOf(() =>
        members.addMember(
          identity(fixture.adminOne),
          fixture.orgA,
          {
            email: fixture.unattachedEmail,
            role: 'seo_manager',
            clientAccess: { mode: 'all_clients' },
          },
          REQUEST,
        ),
      ),
    ).toBe('membership_already_exists');
  });

  it('refuses all_clients for a client_viewer', async () => {
    expect(
      await failureOf(() =>
        members.addMember(
          identity(fixture.adminOne),
          fixture.orgA,
          {
            email: fixture.foreignAdmin.email,
            role: 'client_viewer',
            clientAccess: { mode: 'all_clients' },
          },
          REQUEST,
        ),
      ),
    ).toBe('client_viewer_requires_scoped');
  });

  it('refuses a client belonging to another organization, without saying which', async () => {
    const failure = await failureOf(() =>
      members.addMember(
        identity(fixture.adminOne),
        fixture.orgA,
        {
          email: fixture.foreignAdmin.email,
          role: 'analyst',
          clientAccess: { mode: 'scoped', clientIds: [fixture.clientB1] },
        },
        REQUEST,
      ),
    );

    expect(failure).toBe('resource_not_in_organization');

    // And nothing was written: the whole transaction rolled back.
    const listed = await members.listMembers(identity(fixture.adminOne), fixture.orgA);
    expect(listed.some((row) => row.email === fixture.foreignAdmin.email)).toBe(false);
  });

  it('cleans up after itself: the removed member can be re-attached', async () => {
    await members.removeMember(
      identity(fixture.adminOne),
      fixture.orgA,
      { membershipId: (await findMembership(fixture.unattachedUserId)) ?? '' },
      REQUEST,
    );

    const listed = await members.listMembers(identity(fixture.adminOne), fixture.orgA);
    expect(listed.some((row) => row.userId === fixture.unattachedUserId)).toBe(false);
  });
});

async function findMembership(userId: string): Promise<string | null> {
  const listed = await members.listMembers(identity(fixture.adminOne), fixture.orgA);
  return listed.find((row) => row.userId === userId)?.membershipId ?? null;
}

describe('changing a role', () => {
  beforeEach(async () => {
    // Reset the manager to a known state without going through the service.
    //
    // Order matters, and the database enforces it: `memberships_client_viewer_is_scoped`
    // forbids a `client_viewer` from holding `all_clients`. A test that has just made
    // the manager a client_viewer must therefore restore the *role* first — widening
    // the access mode while the old role is still in place is exactly the state the
    // CHECK exists to reject.
    await withTenantTransaction(
      database.runtime.db,
      tenantOf(fixture.orgA, fixture.adminOne),
      async (r) => {
        await r.memberships.updateRole(fixture.manager.membershipId, 'seo_manager');
        await r.membershipClientScopes.deleteAllForMembership(fixture.manager.membershipId);
        await r.memberships.updateClientAccessMode(fixture.manager.membershipId, 'all_clients');
      },
    );
  });

  it('changes another member role and revokes every session they hold', async () => {
    await openSession(fixture.manager.userId);
    await openSession(fixture.manager.userId);
    await openSession(fixture.analyst.userId);

    expect(await liveSessionCount(fixture.manager.userId)).toBe(2);
    const unrelatedBefore = await liveSessionCount(fixture.analyst.userId);

    const updated = await members.changeMemberRole(
      identity(fixture.adminOne),
      fixture.orgA,
      { membershipId: fixture.manager.membershipId, role: 'content_editor' },
      REQUEST,
    );

    expect(updated.role).toBe('content_editor');
    expect(await liveSessionCount(fixture.manager.userId)).toBe(0);
    // An unrelated member is untouched.
    expect(await liveSessionCount(fixture.analyst.userId)).toBe(unrelatedBefore);
  });

  it('writes an audit record with the correct before and after', async () => {
    await members.changeMemberRole(
      identity(fixture.adminTwo),
      fixture.orgA,
      { membershipId: fixture.manager.membershipId, role: 'analyst' },
      REQUEST,
    );

    const entry = (await auditRows(fixture.orgA, fixture.adminOne))[0];

    expect(entry?.action).toBe('membership.role_changed');
    expect(entry?.actorId).toBe(fixture.adminTwo.userId);
    expect(entry?.actorMembershipId).toBe(fixture.adminTwo.membershipId);
    expect(entry?.before).toMatchObject({ role: 'seo_manager', userId: fixture.manager.userId });
    expect(entry?.after).toMatchObject({ role: 'analyst', userId: fixture.manager.userId });
  });

  it('is an idempotent no-op when the role is unchanged', async () => {
    await openSession(fixture.manager.userId);
    const auditBefore = (await auditRows(fixture.orgA, fixture.adminOne)).length;

    const unchanged = await members.changeMemberRole(
      identity(fixture.adminOne),
      fixture.orgA,
      { membershipId: fixture.manager.membershipId, role: 'seo_manager' },
      REQUEST,
    );

    expect(unchanged.role).toBe('seo_manager');
    expect(await liveSessionCount(fixture.manager.userId)).toBe(1);
    expect((await auditRows(fixture.orgA, fixture.adminOne)).length).toBe(auditBefore);
  });

  it('narrows an all_clients membership to zero clients when it becomes a client_viewer', async () => {
    const updated = await members.changeMemberRole(
      identity(fixture.adminOne),
      fixture.orgA,
      { membershipId: fixture.manager.membershipId, role: 'client_viewer' },
      REQUEST,
    );

    // Never widened, and never left in a state the CHECK constraint forbids.
    expect(updated.role).toBe('client_viewer');
    expect(updated.clientAccessMode).toBe('scoped');
    expect(updated.scopedClientIds).toEqual([]);
    expect(await scopeOf(fixture.orgA, fixture.adminOne, fixture.manager.membershipId)).toEqual([]);
  });

  it('keeps an existing scope when a scoped member becomes a client_viewer', async () => {
    const updated = await members.changeMemberRole(
      identity(fixture.adminOne),
      fixture.orgA,
      { membershipId: fixture.analyst.membershipId, role: 'client_viewer' },
      REQUEST,
    );

    expect(updated.clientAccessMode).toBe('scoped');
    expect([...updated.scopedClientIds].sort()).toEqual(
      [fixture.clientA1, fixture.clientA2].sort(),
    );

    await members.changeMemberRole(
      identity(fixture.adminOne),
      fixture.orgA,
      { membershipId: fixture.analyst.membershipId, role: 'analyst' },
      REQUEST,
    );
  });

  it('refuses a non-admin', async () => {
    expect(
      await failureOf(() =>
        members.changeMemberRole(
          identity(fixture.analyst),
          fixture.orgA,
          { membershipId: fixture.manager.membershipId, role: 'agency_admin' },
          REQUEST,
        ),
      ),
    ).toBe('permission_denied');
  });

  it('refuses a self role change', async () => {
    expect(
      await failureOf(() =>
        members.changeMemberRole(
          identity(fixture.adminOne),
          fixture.orgA,
          { membershipId: fixture.adminOne.membershipId, role: 'analyst' },
          REQUEST,
        ),
      ),
    ).toBe('self_mutation_forbidden');

    expect(await roleOf(fixture.orgA, fixture.adminOne, fixture.adminOne.membershipId)).toBe(
      'agency_admin',
    );
  });

  it('cannot lose its only agency admin through role changes', async () => {
    // Organization C has exactly one. Every sequential route to demoting them is
    // closed, and the two guards close different halves of it:
    //
    //   * the admin themselves is refused by the self-mutation rule;
    //   * everybody else is refused because no other role holds member.update_role.
    //
    // Which means `last_agency_admin` itself is unreachable *sequentially* — the
    // caller is always an agency admin and therefore always counts as one that
    // remains. It becomes reachable the moment two administrators act at once, which
    // is what `membership-concurrency.int.test.ts` exists to prove.
    expect(
      await failureOf(() =>
        members.changeMemberRole(
          identity(fixture.soloAdmin),
          fixture.orgC,
          { membershipId: fixture.soloAdmin.membershipId, role: 'analyst' },
          REQUEST,
        ),
      ),
    ).toBe('self_mutation_forbidden');

    expect(
      await failureOf(() =>
        members.changeMemberRole(
          identity(fixture.helper),
          fixture.orgC,
          { membershipId: fixture.soloAdmin.membershipId, role: 'analyst' },
          REQUEST,
        ),
      ),
    ).toBe('permission_denied');

    expect(await roleOf(fixture.orgC, fixture.soloAdmin, fixture.soloAdmin.membershipId)).toBe(
      'agency_admin',
    );
  });

  it('refuses a membership id from another organization, as if absent', async () => {
    expect(
      await failureOf(() =>
        members.changeMemberRole(
          identity(fixture.adminOne),
          fixture.orgA,
          { membershipId: fixture.foreignAdmin.membershipId, role: 'analyst' },
          REQUEST,
        ),
      ),
    ).toBe('resource_not_in_organization');

    // The foreign membership is untouched.
    expect(
      await roleOf(fixture.orgB, fixture.foreignAdmin, fixture.foreignAdmin.membershipId),
    ).toBe('agency_admin');
  });

  it('refuses a malformed membership id without querying for it', async () => {
    for (const membershipId of ['', 'not-a-uuid', "' OR 1=1 --", '0']) {
      expect(
        await failureOf(() =>
          members.changeMemberRole(
            identity(fixture.adminOne),
            fixture.orgA,
            { membershipId, role: 'analyst' },
            REQUEST,
          ),
        ),
      ).toBe('resource_not_in_organization');
    }
  });
});

describe('replacing client scopes', () => {
  beforeEach(async () => {
    await withTenantTransaction(
      database.runtime.db,
      tenantOf(fixture.orgA, fixture.adminOne),
      async (r) => {
        // Role first, for the same reason as the block above: a member left as a
        // client_viewer by a previous test may not be widened while that role stands.
        await r.memberships.updateRole(fixture.analyst.membershipId, 'analyst');
        await r.membershipClientScopes.deleteAllForMembership(fixture.analyst.membershipId);
        await r.memberships.updateClientAccessMode(fixture.analyst.membershipId, 'scoped');
        await r.membershipClientScopes.add({
          membershipId: fixture.analyst.membershipId,
          clientId: fixture.clientA1,
        });
        await r.membershipClientScopes.add({
          membershipId: fixture.analyst.membershipId,
          clientId: fixture.clientA2,
        });
      },
    );
  });

  it('replaces a scope and revokes sessions when it narrows', async () => {
    await openSession(fixture.analyst.userId);
    await openSession(fixture.analyst.userId);

    const updated = await members.replaceMemberScopes(
      identity(fixture.adminOne),
      fixture.orgA,
      {
        membershipId: fixture.analyst.membershipId,
        clientAccess: { mode: 'scoped', clientIds: [fixture.clientA1] },
      },
      REQUEST,
    );

    expect(updated.scopedClientIds).toEqual([fixture.clientA1]);
    expect(await liveSessionCount(fixture.analyst.userId)).toBe(0);
  });

  it('treats an empty scoped list as exactly zero clients', async () => {
    const updated = await members.replaceMemberScopes(
      identity(fixture.adminOne),
      fixture.orgA,
      {
        membershipId: fixture.analyst.membershipId,
        clientAccess: { mode: 'scoped', clientIds: [] },
      },
      REQUEST,
    );

    expect(updated.clientAccessMode).toBe('scoped');
    expect(updated.scopedClientIds).toEqual([]);

    // And the membership really reaches nothing.
    const failure = await failureOf(() =>
      authorization.withAuthorizedOrganization(
        identity(fixture.analyst),
        fixture.orgA,
        async (session: AuthorizedOrganizationSession) =>
          session.requireClient('client.read', fixture.clientA1),
      ),
    );

    expect(failure).toBe('client_out_of_scope');
  });

  it('does not revoke when the scope broadens', async () => {
    await withTenantTransaction(
      database.runtime.db,
      tenantOf(fixture.orgA, fixture.adminOne),
      async (r) => {
        await r.membershipClientScopes.deleteAllForMembership(fixture.analyst.membershipId);
        await r.membershipClientScopes.add({
          membershipId: fixture.analyst.membershipId,
          clientId: fixture.clientA1,
        });
      },
    );

    await openSession(fixture.analyst.userId);
    const before = await liveSessionCount(fixture.analyst.userId);

    await members.replaceMemberScopes(
      identity(fixture.adminOne),
      fixture.orgA,
      {
        membershipId: fixture.analyst.membershipId,
        clientAccess: { mode: 'scoped', clientIds: [fixture.clientA1, fixture.clientA2] },
      },
      REQUEST,
    );

    expect(await liveSessionCount(fixture.analyst.userId)).toBe(before);
  });

  it('does not revoke when scoped becomes all_clients, and clears the scope rows', async () => {
    await openSession(fixture.analyst.userId);
    const before = await liveSessionCount(fixture.analyst.userId);

    const updated = await members.replaceMemberScopes(
      identity(fixture.adminOne),
      fixture.orgA,
      { membershipId: fixture.analyst.membershipId, clientAccess: { mode: 'all_clients' } },
      REQUEST,
    );

    expect(updated.clientAccessMode).toBe('all_clients');
    expect(updated.scopedClientIds).toEqual([]);
    expect(await scopeOf(fixture.orgA, fixture.adminOne, fixture.analyst.membershipId)).toEqual([]);
    expect(await liveSessionCount(fixture.analyst.userId)).toBe(before);
  });

  it('revokes when all_clients becomes scoped', async () => {
    await members.replaceMemberScopes(
      identity(fixture.adminOne),
      fixture.orgA,
      { membershipId: fixture.analyst.membershipId, clientAccess: { mode: 'all_clients' } },
      REQUEST,
    );

    await openSession(fixture.analyst.userId);
    expect(await liveSessionCount(fixture.analyst.userId)).toBeGreaterThan(0);

    await members.replaceMemberScopes(
      identity(fixture.adminOne),
      fixture.orgA,
      {
        membershipId: fixture.analyst.membershipId,
        clientAccess: { mode: 'scoped', clientIds: [fixture.clientA1, fixture.clientA2] },
      },
      REQUEST,
    );

    expect(await liveSessionCount(fixture.analyst.userId)).toBe(0);
  });

  it('refuses a client of another organization and changes nothing', async () => {
    const failure = await failureOf(() =>
      members.replaceMemberScopes(
        identity(fixture.adminOne),
        fixture.orgA,
        {
          membershipId: fixture.analyst.membershipId,
          clientAccess: { mode: 'scoped', clientIds: [fixture.clientA1, fixture.clientB1] },
        },
        REQUEST,
      ),
    );

    expect(failure).toBe('resource_not_in_organization');
    expect(await scopeOf(fixture.orgA, fixture.adminOne, fixture.analyst.membershipId)).toEqual(
      [fixture.clientA1, fixture.clientA2].sort(),
    );
  });

  it('refuses all_clients for a client_viewer', async () => {
    expect(
      await failureOf(() =>
        members.replaceMemberScopes(
          identity(fixture.adminOne),
          fixture.orgA,
          { membershipId: fixture.viewer.membershipId, clientAccess: { mode: 'all_clients' } },
          REQUEST,
        ),
      ),
    ).toBe('client_viewer_requires_scoped');
  });

  it('refuses a self scope change', async () => {
    expect(
      await failureOf(() =>
        members.replaceMemberScopes(
          identity(fixture.adminOne),
          fixture.orgA,
          { membershipId: fixture.adminOne.membershipId, clientAccess: { mode: 'all_clients' } },
          REQUEST,
        ),
      ),
    ).toBe('self_mutation_forbidden');
  });

  it('refuses a non-admin', async () => {
    expect(
      await failureOf(() =>
        members.replaceMemberScopes(
          identity(fixture.viewer),
          fixture.orgA,
          {
            membershipId: fixture.analyst.membershipId,
            clientAccess: { mode: 'scoped', clientIds: [] },
          },
          REQUEST,
        ),
      ),
    ).toBe('permission_denied');
  });

  it('writes an audit record naming both states', async () => {
    await members.replaceMemberScopes(
      identity(fixture.adminOne),
      fixture.orgA,
      {
        membershipId: fixture.analyst.membershipId,
        clientAccess: { mode: 'scoped', clientIds: [fixture.clientA2] },
      },
      REQUEST,
    );

    const entry = (await auditRows(fixture.orgA, fixture.adminOne))[0];

    expect(entry?.action).toBe('membership.scope_changed');
    expect(entry?.before).toMatchObject({ clientAccessMode: 'scoped' });
    expect(entry?.after).toMatchObject({
      clientAccessMode: 'scoped',
      scopedClientIds: [fixture.clientA2],
    });
  });
});

describe('removing a member', () => {
  it('removes, revokes every session and audits, all together', async () => {
    const attached = await members.addMember(
      identity(fixture.adminOne),
      fixture.orgA,
      { email: fixture.unattachedEmail, role: 'analyst', clientAccess: { mode: 'all_clients' } },
      REQUEST,
    );

    await openSession(fixture.unattachedUserId);
    await openSession(fixture.unattachedUserId);
    await openSession(fixture.adminTwo.userId);

    const unrelatedBefore = await liveSessionCount(fixture.adminTwo.userId);
    expect(await liveSessionCount(fixture.unattachedUserId)).toBe(2);

    await members.removeMember(
      identity(fixture.adminOne),
      fixture.orgA,
      { membershipId: attached.membershipId },
      REQUEST,
    );

    expect(await liveSessionCount(fixture.unattachedUserId)).toBe(0);
    expect(await liveSessionCount(fixture.adminTwo.userId)).toBe(unrelatedBefore);

    const entry = (await auditRows(fixture.orgA, fixture.adminOne))[0];
    expect(entry?.action).toBe('membership.removed');
    expect(entry?.targetId).toBe(attached.membershipId);
    expect(entry?.before).toMatchObject({ userId: fixture.unattachedUserId, role: 'analyst' });
    expect(entry?.after).toBeNull();

    // And the membership really stops authorizing.
    expect(
      await failureOf(() =>
        authorization.withAuthorizedOrganization(
          { userId: fixture.unattachedUserId },
          fixture.orgA,
          async () => Promise.resolve(null),
        ),
      ),
    ).toBe('no_membership');
  });

  it('refuses a non-admin', async () => {
    expect(
      await failureOf(() =>
        members.removeMember(
          identity(fixture.viewer),
          fixture.orgA,
          { membershipId: fixture.manager.membershipId },
          REQUEST,
        ),
      ),
    ).toBe('permission_denied');
  });

  it('refuses self-removal', async () => {
    expect(
      await failureOf(() =>
        members.removeMember(
          identity(fixture.adminOne),
          fixture.orgA,
          { membershipId: fixture.adminOne.membershipId },
          REQUEST,
        ),
      ),
    ).toBe('self_mutation_forbidden');
  });

  it('cannot lose its only agency admin through removals', async () => {
    // The same closed shape as the role case: the admin is refused by the
    // self-mutation rule, everybody else by the permission check.
    expect(
      await failureOf(() =>
        members.removeMember(
          identity(fixture.soloAdmin),
          fixture.orgC,
          { membershipId: fixture.soloAdmin.membershipId },
          REQUEST,
        ),
      ),
    ).toBe('self_mutation_forbidden');

    expect(
      await failureOf(() =>
        members.removeMember(
          identity(fixture.helper),
          fixture.orgC,
          { membershipId: fixture.soloAdmin.membershipId },
          REQUEST,
        ),
      ),
    ).toBe('permission_denied');

    const remaining = await members.listMembers(identity(fixture.soloAdmin), fixture.orgC);
    expect(remaining.filter((row) => row.role === 'agency_admin')).toHaveLength(1);
  });

  it('removes an agency admin while others remain', async () => {
    const extra = await members.addMember(
      identity(fixture.adminOne),
      fixture.orgA,
      {
        email: fixture.unattachedEmail,
        role: 'agency_admin',
        clientAccess: { mode: 'all_clients' },
      },
      REQUEST,
    );

    const adminsBefore = (
      await members.listMembers(identity(fixture.adminOne), fixture.orgA)
    ).filter((row) => row.role === 'agency_admin').length;
    expect(adminsBefore).toBeGreaterThan(1);

    await members.removeMember(
      identity(fixture.adminOne),
      fixture.orgA,
      { membershipId: extra.membershipId },
      REQUEST,
    );

    const remaining = await members.listMembers(identity(fixture.adminOne), fixture.orgA);
    expect(remaining.some((row) => row.membershipId === extra.membershipId)).toBe(false);
    expect(remaining.filter((row) => row.role === 'agency_admin')).toHaveLength(adminsBefore - 1);
  });

  it('refuses a membership id from another organization', async () => {
    expect(
      await failureOf(() =>
        members.removeMember(
          identity(fixture.adminOne),
          fixture.orgA,
          { membershipId: fixture.foreignAdmin.membershipId },
          REQUEST,
        ),
      ),
    ).toBe('resource_not_in_organization');
  });
});

describe('atomicity of the mutation, the revocation and the audit record', () => {
  it('rolls all three back together when the transaction fails', async () => {
    const sessionRecord = await openSession(fixture.manager.userId);
    expect(sessionRecord.revokedAt).toBeNull();

    const roleBefore = await roleOf(fixture.orgA, fixture.adminOne, fixture.manager.membershipId);
    const auditBefore = (await auditRows(fixture.orgA, fixture.adminOne)).length;
    const liveBefore = await liveSessionCount(fixture.manager.userId);

    expect(liveBefore).toBeGreaterThan(0);

    // A service whose transaction throws *after* the work is done. The membership
    // write, the session revocation and the audit insert all happened; the commit
    // does not.
    const failing: AuthorizationService = {
      listOrganizations: async (id: AuthenticatedIdentityRef) =>
        authorization.listOrganizations(id),
      withAuthorizedOrganization: async <T>(
        id: AuthenticatedIdentityRef,
        organizationId: string,
        fn: (session: AuthorizedOrganizationSession) => Promise<T>,
      ): Promise<T> =>
        authorization.withAuthorizedOrganization(id, organizationId, async (session) => {
          await fn(session);
          throw new Error('injected failure after the work completed');
        }),
    };

    const failingMembers = createMemberAdministrationService({
      authorization: failing,
      db: database.runtime.db,
    });

    await expect(
      failingMembers.changeMemberRole(
        identity(fixture.adminOne),
        fixture.orgA,
        { membershipId: fixture.manager.membershipId, role: 'content_editor' },
        REQUEST,
      ),
    ).rejects.toThrow('injected failure');

    // Nothing survived: no half-applied security mutation exists to detect or repair.
    expect(await roleOf(fixture.orgA, fixture.adminOne, fixture.manager.membershipId)).toBe(
      roleBefore,
    );
    expect(await liveSessionCount(fixture.manager.userId)).toBe(liveBefore);
    expect((await auditRows(fixture.orgA, fixture.adminOne)).length).toBe(auditBefore);
  });
});

describe('audit integrity', () => {
  it('creates no record for a refused mutation', async () => {
    const before = (await auditRows(fixture.orgA, fixture.adminOne)).length;

    await failureOf(() =>
      members.changeMemberRole(
        identity(fixture.viewer),
        fixture.orgA,
        { membershipId: fixture.manager.membershipId, role: 'agency_admin' },
        REQUEST,
      ),
    );

    await failureOf(() =>
      members.removeMember(
        identity(fixture.adminOne),
        fixture.orgA,
        { membershipId: fixture.foreignAdmin.membershipId },
        REQUEST,
      ),
    );

    expect((await auditRows(fixture.orgA, fixture.adminOne)).length).toBe(before);
  });

  it('records no secret value in any field', async () => {
    const rows = await auditRows(fixture.orgA, fixture.adminOne);
    const serialized = JSON.stringify(rows);

    for (const forbidden of [
      'password',
      'passwordHash',
      'password_hash',
      'argon2',
      'tokenHash',
      'token_hash',
      'csrf',
      'cookie',
      'isPlatformAdmin',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('cannot be updated by the runtime role', async () => {
    await expect(
      database.runtime.db.execute(sql`UPDATE audit_logs SET action = 'tampered'`),
    ).rejects.toThrow();
  });

  it('cannot be deleted by the runtime role', async () => {
    await expect(database.runtime.db.execute(sql`DELETE FROM audit_logs`)).rejects.toThrow();
  });

  it('is not visible from another organization', async () => {
    const foreign = await auditRows(fixture.orgB, fixture.foreignAdmin);

    expect(foreign.every((row) => row.organizationId === fixture.orgB)).toBe(true);
  });
});
