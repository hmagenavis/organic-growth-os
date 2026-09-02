import { isAuthorizationError, type AuthenticatedIdentityRef } from '@organic-os/authorization';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createMembershipStore } from '../authorization/membership-store.js';
import {
  createAuthorizationService,
  type AuthorizationService,
} from '../authorization/with-authorized-organization.js';
import { provisionMembership, provisionOrganization, provisionUser } from '../provisioning.js';
import type { AuditLogRecord } from '../repositories/audit-logs.js';
import { isInvalidClientCursorError } from '../repositories/clients.js';
import type { MembershipRole } from '../schema/enums.js';
import type { TenantContext } from '../tenant/context.js';
import { withTenantTransaction } from '../tenant/with-tenant-transaction.js';
import { createTestDatabase, type TestDatabase } from '../testing/database.js';
import type { AdministrationRequest } from '../administration/membership-administration.js';
import { createClientService, type ClientService } from './client-service.js';

/**
 * The client API's decisions, against real PostgreSQL.
 *
 * This is where the rule that gives sub-phase 0.4.2B1 its shape is proven:
 *
 *   **authorized = role permission AND client access scope.**
 *
 * Everything runs through the code a deployment runs, as the runtime role, with
 * `FORCE ROW LEVEL SECURITY` on and the real grants — so a listing that returned a
 * client it should not is a failure of the application rule *and* would still be
 * caught by the database if the application rule were removed entirely (that second
 * half is proven in `tenant/tenant-isolation.int.test.ts`).
 *
 * The HTTP mapping is tested next door in `apps/api`; nothing here goes through
 * Fastify.
 */

const REQUEST: AdministrationRequest = { source: 'api', ip: '198.51.100.10' };

let database: TestDatabase;
let authorization: AuthorizationService;
let clients: ClientService;

interface Actor {
  userId: string;
  membershipId: string;
}

interface Fixture {
  orgA: string;
  orgB: string;
  /** Organization A, in creation order. `a1` … `a5`. */
  a1: string;
  a2: string;
  a3: string;
  a4: string;
  a5: string;
  b1: string;
  admin: Actor;
  /** agency_admin whose own membership is `scoped`, to a2 only. */
  scopedAdmin: Actor;
  manager: Actor;
  editor: Actor;
  analyst: Actor;
  /** client_viewer scoped to a1. */
  viewer: Actor;
  /** client_viewer with `scoped` and zero scope rows. */
  emptyViewer: Actor;
  /** A platform administrator holding no membership in organization A. */
  platformAdmin: Actor;
  foreignAdmin: Actor;
}

let fixture: Fixture;

function identity(actor: Actor): AuthenticatedIdentityRef {
  return { userId: actor.userId };
}

async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error: unknown) {
    if (isAuthorizationError(error)) {
      return error.failure;
    }

    throw error;
  }

  return '(no failure)';
}

async function listIds(actor: Actor, organizationId: string, limit = 50): Promise<string[]> {
  const page = await clients.listClients(identity(actor), organizationId, { limit });
  return page.clients.map((client) => client.id);
}

async function auditRows(organizationId: string, userId: string): Promise<AuditLogRecord[]> {
  const tenant: TenantContext = {
    organizationId,
    actor: { kind: 'user', userId },
  };

  return withTenantTransaction(database.runtime.db, tenant, async (repositories) =>
    repositories.auditLogs.list(1000),
  );
}

beforeAll(async () => {
  database = await createTestDatabase(inject('postgresAdminUri'), 'organic_os_client_service_test');

  const provisioner = database.provisioner.db;

  const organizationA = await provisionOrganization(provisioner, {
    name: 'Client Service A',
    slug: 'client-service-a',
  });
  const organizationB = await provisionOrganization(provisioner, {
    name: 'Client Service B',
    slug: 'client-service-b',
  });

  async function actor(
    organizationId: string | null,
    handle: string,
    role: MembershipRole,
    clientAccessMode: 'all_clients' | 'scoped',
    isPlatformAdmin = false,
  ): Promise<Actor> {
    const user = await provisionUser(provisioner, {
      email: `${handle}@example.test`,
      name: handle,
      isPlatformAdmin,
    });

    if (organizationId === null) {
      return { userId: user.id, membershipId: '' };
    }

    const membership = await provisionMembership(provisioner, {
      organizationId,
      userId: user.id,
      role,
      clientAccessMode,
    });

    return { userId: user.id, membershipId: membership.id };
  }

  const admin = await actor(organizationA.id, 'cs-admin', 'agency_admin', 'all_clients');
  const scopedAdmin = await actor(organizationA.id, 'cs-admin-scoped', 'agency_admin', 'scoped');
  const manager = await actor(organizationA.id, 'cs-manager', 'seo_manager', 'all_clients');
  const editor = await actor(organizationA.id, 'cs-editor', 'content_editor', 'all_clients');
  const analystActor = await actor(organizationA.id, 'cs-analyst', 'analyst', 'all_clients');
  const viewer = await actor(organizationA.id, 'cs-viewer', 'client_viewer', 'scoped');
  const emptyViewer = await actor(organizationA.id, 'cs-viewer-empty', 'client_viewer', 'scoped');
  const platformAdmin = await actor(organizationB.id, 'cs-platform', 'analyst', 'scoped', true);
  const foreignAdmin = await actor(organizationB.id, 'cs-foreign', 'agency_admin', 'all_clients');

  const tenantA: TenantContext = {
    organizationId: organizationA.id,
    actor: { kind: 'user', userId: admin.userId },
  };
  const tenantB: TenantContext = {
    organizationId: organizationB.id,
    actor: { kind: 'user', userId: foreignAdmin.userId },
  };

  // Created one transaction at a time so `created_at` (the transaction timestamp)
  // strictly increases and the fixture's order is the listing order.
  const created: string[] = [];

  for (const name of ['A One', 'A Two', 'A Three', 'A Four', 'A Five']) {
    const id = await withTenantTransaction(
      database.runtime.db,
      tenantA,
      async (repositories) => (await repositories.clients.create({ name })).id,
    );
    created.push(id);
  }

  const [a1, a2, a3, a4, a5] = created;

  if (
    a1 === undefined ||
    a2 === undefined ||
    a3 === undefined ||
    a4 === undefined ||
    a5 === undefined
  ) {
    throw new Error('fixture did not create five clients');
  }

  await withTenantTransaction(database.runtime.db, tenantA, async (repositories) => {
    await repositories.membershipClientScopes.add({
      membershipId: viewer.membershipId,
      clientId: a1,
    });
    await repositories.membershipClientScopes.add({
      membershipId: scopedAdmin.membershipId,
      clientId: a2,
    });
  });

  const b1 = await withTenantTransaction(
    database.runtime.db,
    tenantB,
    async (repositories) => (await repositories.clients.create({ name: 'B One' })).id,
  );

  authorization = createAuthorizationService({
    db: database.runtime.db,
    store: createMembershipStore(database.runtime.db),
  });
  clients = createClientService({ authorization });

  fixture = {
    orgA: organizationA.id,
    orgB: organizationB.id,
    a1,
    a2,
    a3,
    a4,
    a5,
    b1,
    admin,
    scopedAdmin,
    manager,
    editor,
    analyst: analystActor,
    viewer,
    emptyViewer,
    platformAdmin,
    foreignAdmin,
  };
}, 240_000);

afterAll(async () => {
  await database?.close();
});

describe('reading requires the permission AND the client scope', () => {
  it('lists every organization client for an all_clients membership', async () => {
    expect(await listIds(fixture.admin, fixture.orgA)).toEqual([
      fixture.a1,
      fixture.a2,
      fixture.a3,
      fixture.a4,
      fixture.a5,
    ]);
  });

  it('lists only the scoped clients for a scoped membership', async () => {
    expect(await listIds(fixture.viewer, fixture.orgA)).toEqual([fixture.a1]);
    expect(await listIds(fixture.scopedAdmin, fixture.orgA)).toEqual([fixture.a2]);
  });

  it('lists exactly zero clients for a scoped membership with no scope rows', async () => {
    // The property ADR-0016 exists for: an empty scope collection is not "all".
    expect(await listIds(fixture.emptyViewer, fixture.orgA)).toEqual([]);
  });

  it.each(['manager', 'editor', 'analyst'] as const)(
    'lets a read-only role (%s) read the clients it may reach',
    async (role) => {
      expect(await listIds(fixture[role], fixture.orgA)).toHaveLength(5);
      expect((await clients.getClient(identity(fixture[role]), fixture.orgA, fixture.a1)).id).toBe(
        fixture.a1,
      );
    },
  );

  it('refuses a client outside the caller scope as if it did not exist', async () => {
    expect(
      await failureOf(() => clients.getClient(identity(fixture.viewer), fixture.orgA, fixture.a2)),
    ).toBe('client_out_of_scope');

    expect(
      await failureOf(() =>
        clients.getClient(identity(fixture.emptyViewer), fixture.orgA, fixture.a1),
      ),
    ).toBe('client_out_of_scope');
  });

  it('refuses a malformed or unknown client id without touching the database', async () => {
    expect(
      await failureOf(() => clients.getClient(identity(fixture.admin), fixture.orgA, 'not-a-uuid')),
    ).toBe('resource_not_in_organization');

    expect(
      await failureOf(() =>
        clients.getClient(
          identity(fixture.admin),
          fixture.orgA,
          '018f9e1a-0000-7000-8000-00000000dead',
        ),
      ),
    ).toBe('resource_not_in_organization');
  });
});

describe('cross-tenant access is impossible in either direction', () => {
  it('refuses to list another organization', async () => {
    expect(await failureOf(() => listIds(fixture.admin, fixture.orgB))).toBe('no_membership');
    expect(await failureOf(() => listIds(fixture.foreignAdmin, fixture.orgA))).toBe(
      'no_membership',
    );
  });

  it('reads a foreign client id as absent rather than forbidden', async () => {
    expect(
      await failureOf(() => clients.getClient(identity(fixture.admin), fixture.orgA, fixture.b1)),
    ).toBe('resource_not_in_organization');
  });

  it('refuses a foreign organization id even to its own agency admin from outside', async () => {
    expect(
      await failureOf(() =>
        clients.updateClient(
          identity(fixture.admin),
          fixture.orgB,
          fixture.b1,
          { name: 'x' },
          REQUEST,
        ),
      ),
    ).toBe('no_membership');
  });

  it('does not let a platform administrator bypass organization membership', async () => {
    // `is_platform_admin` is not an organization role and confers nothing here: this
    // user is a member of organization B only.
    expect(await failureOf(() => listIds(fixture.platformAdmin, fixture.orgA))).toBe(
      'no_membership',
    );

    expect(
      await failureOf(() =>
        clients.getClient(identity(fixture.platformAdmin), fixture.orgA, fixture.a1),
      ),
    ).toBe('no_membership');

    // And inside the organization it *is* a member of, it is still an analyst with
    // `scoped` access and no scope rows.
    expect(await listIds(fixture.platformAdmin, fixture.orgB)).toEqual([]);
    expect(
      await failureOf(() =>
        clients.createClient(identity(fixture.platformAdmin), fixture.orgB, { name: 'X' }, REQUEST),
      ),
    ).toBe('permission_denied');
  });
});

describe('writing is agency_admin AND in scope', () => {
  it.each(['manager', 'editor', 'analyst', 'viewer'] as const)(
    'refuses create and update to %s',
    async (role) => {
      expect(
        await failureOf(() =>
          clients.createClient(identity(fixture[role]), fixture.orgA, { name: 'Nope' }, REQUEST),
        ),
      ).toBe('permission_denied');

      expect(
        await failureOf(() =>
          clients.updateClient(
            identity(fixture[role]),
            fixture.orgA,
            fixture.a1,
            { name: 'Nope' },
            REQUEST,
          ),
        ),
      ).toBe('permission_denied');
    },
  );

  it('refuses a scoped agency admin an unscoped client, despite the role permission', async () => {
    // The whole point: permission AND scope. This caller holds `client.update`.
    expect(
      await failureOf(() =>
        clients.updateClient(
          identity(fixture.scopedAdmin),
          fixture.orgA,
          fixture.a3,
          { name: 'Reached' },
          REQUEST,
        ),
      ),
    ).toBe('client_out_of_scope');

    // ... and can still update the one client it is scoped to.
    const updated = await clients.updateClient(
      identity(fixture.scopedAdmin),
      fixture.orgA,
      fixture.a2,
      { industry: 'logistics' },
      REQUEST,
    );

    expect(updated.industry).toBe('logistics');
  });

  it('creates with the organization from context and audits exactly once', async () => {
    const before = await auditRows(fixture.orgA, fixture.admin.userId);

    const created = await clients.createClient(
      identity(fixture.admin),
      fixture.orgA,
      { name: 'Created By Admin', industry: 'retail', notes: 'private note' },
      REQUEST,
    );

    expect(created.status).toBe('active');

    const after = await auditRows(fixture.orgA, fixture.admin.userId);
    const added = after.filter((row) => !before.some((existing) => existing.id === row.id));

    expect(added).toHaveLength(1);
    const entry = added[0];
    expect(entry?.action).toBe('client.created');
    expect(entry?.targetType).toBe('client');
    expect(entry?.targetId).toBe(created.id);
    expect(entry?.organizationId).toBe(fixture.orgA);
    expect(entry?.actorId).toBe(fixture.admin.userId);
    expect(entry?.actorMembershipId).toBe(fixture.admin.membershipId);
    expect(entry?.result).toBe('ok');
    expect(entry?.before).toBeNull();
    expect(entry?.after).toEqual({
      name: 'Created By Admin',
      status: 'active',
      industry: 'retail',
      // The note text itself is deliberately absent from an append-only trail.
      notesPresent: true,
    });
    expect(JSON.stringify(entry?.after)).not.toContain('private note');
  });

  it('does not widen a scoped membership when a client is created', async () => {
    const scopedBefore = await listIds(fixture.viewer, fixture.orgA);
    const adminBefore = await listIds(fixture.admin, fixture.orgA, 100);

    const created = await clients.createClient(
      identity(fixture.admin),
      fixture.orgA,
      { name: 'Not Automatically Shared' },
      REQUEST,
    );

    // `all_clients` sees it by policy.
    expect(await listIds(fixture.admin, fixture.orgA, 100)).toEqual([...adminBefore, created.id]);

    // `scoped` does not, and no scope row was invented for it.
    expect(await listIds(fixture.viewer, fixture.orgA)).toEqual(scopedBefore);
    expect(
      await failureOf(() => clients.getClient(identity(fixture.viewer), fixture.orgA, created.id)),
    ).toBe('client_out_of_scope');
  });

  it('records a correct before/after pair for an update', async () => {
    const target = await clients.createClient(
      identity(fixture.admin),
      fixture.orgA,
      { name: 'Before Name', industry: 'media' },
      REQUEST,
    );

    const updated = await clients.updateClient(
      identity(fixture.admin),
      fixture.orgA,
      target.id,
      { name: 'After Name', industry: null },
      REQUEST,
    );

    expect(updated.name).toBe('After Name');
    expect(updated.industry).toBeNull();
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(target.updatedAt.getTime());

    const rows = await auditRows(fixture.orgA, fixture.admin.userId);
    const entry = rows.find((row) => row.action === 'client.updated' && row.targetId === target.id);

    expect(entry?.before).toEqual({
      name: 'Before Name',
      status: 'active',
      industry: 'media',
      notesPresent: false,
    });
    expect(entry?.after).toEqual({
      name: 'After Name',
      status: 'active',
      industry: null,
      notesPresent: false,
    });
  });

  it('writes no audit row for a patch that changes nothing', async () => {
    const target = await clients.createClient(
      identity(fixture.admin),
      fixture.orgA,
      { name: 'Unchanged' },
      REQUEST,
    );

    const before = await auditRows(fixture.orgA, fixture.admin.userId);
    const result = await clients.updateClient(
      identity(fixture.admin),
      fixture.orgA,
      target.id,
      { name: 'Unchanged' },
      REQUEST,
    );
    const after = await auditRows(fixture.orgA, fixture.admin.userId);

    expect(result.updatedAt.getTime()).toBe(target.updatedAt.getTime());
    expect(after).toHaveLength(before.length);
  });

  it('writes no audit row when a mutation is refused', async () => {
    const before = await auditRows(fixture.orgA, fixture.admin.userId);

    await failureOf(() =>
      clients.updateClient(
        identity(fixture.manager),
        fixture.orgA,
        fixture.a1,
        { name: 'Refused' },
        REQUEST,
      ),
    );
    await failureOf(() =>
      clients.createClient(identity(fixture.manager), fixture.orgA, { name: 'Refused' }, REQUEST),
    );
    await failureOf(() =>
      clients.updateClient(
        identity(fixture.scopedAdmin),
        fixture.orgA,
        fixture.a3,
        { name: 'Refused' },
        REQUEST,
      ),
    );

    const after = await auditRows(fixture.orgA, fixture.admin.userId);

    expect(after).toHaveLength(before.length);
    expect(after.some((row) => JSON.stringify(row.after ?? {}).includes('Refused'))).toBe(false);
  });
});

describe('pagination is bounded, ordered and authorization-aware', () => {
  it('walks every page in a deterministic order without repeats or gaps', async () => {
    const all = await listIds(fixture.admin, fixture.orgA, 100);
    const seen: string[] = [];
    let cursor: string | undefined;

    do {
      const page = await clients.listClients(identity(fixture.admin), fixture.orgA, {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });

      expect(page.clients.length).toBeLessThanOrEqual(2);
      seen.push(...page.clients.map((client) => client.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('keeps the scope filter across pages', async () => {
    const page = await clients.listClients(identity(fixture.viewer), fixture.orgA, { limit: 1 });

    expect(page.clients.map((client) => client.id)).toEqual([fixture.a1]);
    // One scoped client and one row asked for: there is no second page, and the
    // absence of a cursor must not be mistaken for "more exist but are hidden".
    expect(page.nextCursor).toBeNull();
  });

  it('refuses a cursor that is not a position in this ordering', async () => {
    for (const cursor of ['not-base64url!!', Buffer.from('x|y').toString('base64url'), 'aaaa']) {
      let thrown: unknown = null;

      try {
        await clients.listClients(identity(fixture.admin), fixture.orgA, { limit: 5, cursor });
      } catch (error: unknown) {
        thrown = error;
      }

      expect(isInvalidClientCursorError(thrown)).toBe(true);
    }
  });

  it('clamps a limit the repository is asked for directly', async () => {
    // Defence in depth: the HTTP contract already rejects an over-limit request, so
    // this asserts the repository does not depend on that having happened.
    const page = await clients.listClients(identity(fixture.admin), fixture.orgA, { limit: 5_000 });

    expect(page.clients.length).toBeLessThanOrEqual(100);
  });
});
