import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { provisionMembership, provisionOrganization, provisionUser } from '../provisioning.js';
import { readCurrentOrganizationId } from '../tenant/transaction.js';
import { createTestDatabase, type TestDatabase } from '../testing/database.js';
import { createMembershipStore } from './membership-store.js';

/**
 * The security spike: the membership bootstrap, against real PostgreSQL.
 *
 * Everything else in Phase 0.4.1 rests on one claim — that an authenticated user can
 * be shown to belong to a requested organization *before* any tenant context exists,
 * without that lookup becoming a way to read anyone else's memberships or anything
 * else in the database. This file is where that claim is tested; the authorization
 * layer above it was written only after these passed.
 */

let database: TestDatabase;

interface Fixture {
  organizationAId: string;
  organizationBId: string;
  userAId: string;
  userBId: string;
  membershipAId: string;
  membershipBId: string;
  outsiderId: string;
}

let fixture: Fixture;

beforeAll(async () => {
  database = await createTestDatabase(
    inject('postgresAdminUri'),
    'organic_os_authz_bootstrap_test',
  );

  const provisioner = database.provisioner.db;

  const organizationA = await provisionOrganization(provisioner, {
    name: 'Organization A',
    slug: 'bootstrap-a',
  });
  const organizationB = await provisionOrganization(provisioner, {
    name: 'Organization B',
    slug: 'bootstrap-b',
  });

  const userA = await provisionUser(provisioner, {
    email: 'bootstrap-a@example.test',
    name: 'User A',
  });
  const userB = await provisionUser(provisioner, {
    email: 'bootstrap-b@example.test',
    name: 'User B',
  });
  const outsider = await provisionUser(provisioner, {
    email: 'bootstrap-outsider@example.test',
    name: 'Outsider',
  });

  const membershipA = await provisionMembership(provisioner, {
    organizationId: organizationA.id,
    userId: userA.id,
    role: 'agency_admin',
    clientAccessMode: 'all_clients',
  });
  const membershipB = await provisionMembership(provisioner, {
    organizationId: organizationB.id,
    userId: userB.id,
    role: 'seo_manager',
    clientAccessMode: 'all_clients',
  });

  fixture = {
    organizationAId: organizationA.id,
    organizationBId: organizationB.id,
    userAId: userA.id,
    userBId: userB.id,
    membershipAId: membershipA.id,
    membershipBId: membershipB.id,
    outsiderId: outsider.id,
  };
}, 240_000);

afterAll(async () => {
  await database?.close();
});

describe('resolving your own memberships', () => {
  it('returns the membership a user actually holds', async () => {
    const store = createMembershipStore(database.runtime.db);

    const membership = await store.findMembership(fixture.userAId, fixture.organizationAId);

    expect(membership).toEqual({
      membershipId: fixture.membershipAId,
      organizationId: fixture.organizationAId,
      userId: fixture.userAId,
      role: 'agency_admin',
      clientAccessMode: 'all_clients',
    });
  });

  it('lists every organization the user belongs to, and only those', async () => {
    const store = createMembershipStore(database.runtime.db);

    const memberships = await store.listMemberships(fixture.userAId);

    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.organizationId).toBe(fixture.organizationAId);
    expect(memberships[0]?.organizationName).toBe('Organization A');
  });

  it('returns nothing for a user who belongs to no organization', async () => {
    const store = createMembershipStore(database.runtime.db);

    expect(await store.listMemberships(fixture.outsiderId)).toEqual([]);
    expect(await store.findMembership(fixture.outsiderId, fixture.organizationAId)).toBeNull();
  });
});

describe('what the bootstrap path refuses', () => {
  it("does not let one user resolve another user's membership", async () => {
    const store = createMembershipStore(database.runtime.db);

    // User A asking about organization B — where user B, not user A, is a member.
    expect(await store.findMembership(fixture.userAId, fixture.organizationBId)).toBeNull();

    // And user A cannot see user B's organization in a listing.
    const listed = await store.listMemberships(fixture.userAId);
    expect(listed.map((row) => row.organizationId)).not.toContain(fixture.organizationBId);
  });

  it('refuses a forged organization id', async () => {
    const store = createMembershipStore(database.runtime.db);

    const forged = '00000000-0000-4000-8000-000000000000';
    expect(await store.findMembership(fixture.userAId, forged)).toBeNull();
  });

  it('never consults a membership id, so one cannot be forged', () => {
    // The port takes (userId, organizationId). There is no method that accepts a
    // membership id, which is why a forged one has nothing to attack: user A naming
    // user B's membership can only be expressed as "organization B", already refused
    // above. Asserted structurally so the property survives a refactor.
    const store = createMembershipStore(database.runtime.db);

    expect(Object.keys(store).sort()).toEqual(['findMembership', 'listMemberships']);
    expect(fixture.membershipBId).not.toBe(fixture.membershipAId);
  });

  it('reads nothing at all with no bootstrap context established', async () => {
    // The raw runtime connection, with neither app.current_org_id nor
    // app.authz_user_id set: the policies fail closed exactly like every other one.
    const memberships = await database.runtime.pool.query('SELECT id FROM memberships');
    const organizations = await database.runtime.pool.query('SELECT id FROM organizations');

    expect(memberships.rows).toHaveLength(0);
    expect(organizations.rows).toHaveLength(0);
  });

  it('cannot be widened to another user by a second setting in the same transaction', async () => {
    // Establishing the bootstrap context for user A and then asking for user B's rows
    // returns nothing: the policy compares the row against the setting, so the query
    // predicate is not what constrains it.
    const rows = await database.runtime.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.authz_user_id', ${fixture.userAId}, true)`);

      const result = await tx.execute<{ id: string }>(
        sql`SELECT id FROM memberships WHERE user_id = ${fixture.userBId}`,
      );

      return result.rows;
    });

    expect(rows).toHaveLength(0);
  });
});

describe('the bootstrap grants no tenant access', () => {
  it('leaves app.current_org_id unset throughout', async () => {
    const store = createMembershipStore(database.runtime.db);

    await store.findMembership(fixture.userAId, fixture.organizationAId);

    // The setting is transaction-local and the bootstrap never sets it; a following
    // statement on the same pooled connection sees nothing.
    expect(await readCurrentOrganizationId(database.runtime.db)).toBeNull();
  });

  it('does not open any tenant table', async () => {
    const counts = await database.runtime.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.authz_user_id', ${fixture.userAId}, true)`);

      const clients = await tx.execute<{ id: string }>(sql`SELECT id FROM clients`);
      const sites = await tx.execute<{ id: string }>(sql`SELECT id FROM sites`);
      const settings = await tx.execute<{ id: string }>(sql`SELECT id FROM site_settings`);
      const audit = await tx.execute<{ id: string }>(sql`SELECT id FROM audit_logs`);
      const users = await tx.execute<{ id: string }>(sql`SELECT id FROM users`);

      return [
        clients.rows.length,
        sites.rows.length,
        settings.rows.length,
        audit.rows.length,
        users.rows.length,
      ];
    });

    expect(counts).toEqual([0, 0, 0, 0, 0]);
  });
});
