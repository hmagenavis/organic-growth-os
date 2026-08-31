import { AuthorizationError, type OrganizationRole } from '@organic-os/authorization';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { provisionMembership, provisionOrganization, provisionUser } from '../provisioning.js';
import type { TenantContext } from '../tenant/context.js';
import { readCurrentOrganizationId } from '../tenant/transaction.js';
import { withTenantTransaction } from '../tenant/with-tenant-transaction.js';
import { createTestDatabase, type TestDatabase } from '../testing/database.js';
import { createMembershipStore } from './membership-store.js';
import {
  createAuthorizationService,
  type AuthorizationService,
} from './with-authorized-organization.js';

/**
 * The authorized tenant transaction, end to end, against real PostgreSQL.
 *
 * The spike file next door proves the bootstrap lookup. This one proves what is built
 * on top of it: that tenant context appears only after membership is proven,
 * disappears with the transaction, and that role permissions and client access mode
 * are both enforced against rows the caller cannot influence.
 */

let database: TestDatabase;
let service: AuthorizationService;

interface Actor {
  userId: string;
  role: OrganizationRole;
}

interface Fixture {
  orgA: string;
  orgB: string;
  clientA1: string;
  clientA2: string;
  clientB1: string;
  admin: Actor;
  manager: Actor;
  editor: Actor;
  analyst: Actor;
  viewer: Actor;
  /** agency_admin of organization B. Used to probe across the tenant boundary. */
  foreignAdmin: Actor;
  /** A platform admin who is also an ordinary client_viewer of organization A. */
  platformAdminMember: Actor;
  /** A platform admin holding no membership anywhere. */
  platformAdminOutsider: string;
  outsider: string;
}

let fixture: Fixture;

async function seedClientScope(
  organizationId: string,
  userId: string,
  membershipId: string,
  clientIds: readonly string[],
): Promise<void> {
  const tenant: TenantContext = {
    organizationId,
    actor: { kind: 'user', userId },
  };

  await withTenantTransaction(database.runtime.db, tenant, async (repositories) => {
    for (const clientId of clientIds) {
      await repositories.membershipClientScopes.add({ membershipId, clientId });
    }
  });
}

beforeAll(async () => {
  database = await createTestDatabase(inject('postgresAdminUri'), 'organic_os_authz_test');

  const provisioner = database.provisioner.db;

  const organizationA = await provisionOrganization(provisioner, {
    name: 'Authorization A',
    slug: 'authz-a',
  });
  const organizationB = await provisionOrganization(provisioner, {
    name: 'Authorization B',
    slug: 'authz-b',
  });

  async function member(
    organizationId: string,
    handle: string,
    role: OrganizationRole,
    clientAccessMode: 'all_clients' | 'scoped',
  ): Promise<{ userId: string; membershipId: string }> {
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

    return { userId: user.id, membershipId: membership.id };
  }

  const admin = await member(organizationA.id, 'authz-admin', 'agency_admin', 'all_clients');
  const manager = await member(organizationA.id, 'authz-manager', 'seo_manager', 'scoped');
  const editor = await member(organizationA.id, 'authz-editor', 'content_editor', 'all_clients');
  const analyst = await member(organizationA.id, 'authz-analyst', 'analyst', 'scoped');
  const viewer = await member(organizationA.id, 'authz-viewer', 'client_viewer', 'scoped');
  const foreignAdmin = await member(
    organizationB.id,
    'authz-foreign-admin',
    'agency_admin',
    'all_clients',
  );

  // A platform admin is still an ordinary member: the flag must change nothing here.
  const platformAdminUser = await provisionUser(provisioner, {
    email: 'authz-platform-member@example.test',
    name: 'Platform Admin Member',
    isPlatformAdmin: true,
  });
  const platformAdminMembership = await provisionMembership(provisioner, {
    organizationId: organizationA.id,
    userId: platformAdminUser.id,
    role: 'client_viewer',
    clientAccessMode: 'scoped',
  });

  const platformAdminOutsider = await provisionUser(provisioner, {
    email: 'authz-platform-outsider@example.test',
    name: 'Platform Admin Outsider',
    isPlatformAdmin: true,
  });

  const outsider = await provisionUser(provisioner, {
    email: 'authz-outsider@example.test',
    name: 'Outsider',
  });

  // Clients, created through ordinary tenant repositories.
  const tenantA: TenantContext = {
    organizationId: organizationA.id,
    actor: { kind: 'user', userId: admin.userId },
  };
  const tenantB: TenantContext = {
    organizationId: organizationB.id,
    actor: { kind: 'user', userId: foreignAdmin.userId },
  };

  const { clientA1, clientA2 } = await withTenantTransaction(
    database.runtime.db,
    tenantA,
    async (repositories) => ({
      clientA1: (await repositories.clients.create({ name: 'Client A1' })).id,
      clientA2: (await repositories.clients.create({ name: 'Client A2' })).id,
    }),
  );

  const clientB1 = await withTenantTransaction(
    database.runtime.db,
    tenantB,
    async (repositories) => (await repositories.clients.create({ name: 'Client B1' })).id,
  );

  // seo_manager is scoped to A1 only; client_viewer to A2 only; analyst to nothing.
  await seedClientScope(organizationA.id, admin.userId, manager.membershipId, [clientA1]);
  await seedClientScope(organizationA.id, admin.userId, viewer.membershipId, [clientA2]);
  await seedClientScope(organizationA.id, admin.userId, platformAdminMembership.id, [clientA1]);

  fixture = {
    orgA: organizationA.id,
    orgB: organizationB.id,
    clientA1,
    clientA2,
    clientB1,
    admin: { userId: admin.userId, role: 'agency_admin' },
    manager: { userId: manager.userId, role: 'seo_manager' },
    editor: { userId: editor.userId, role: 'content_editor' },
    analyst: { userId: analyst.userId, role: 'analyst' },
    viewer: { userId: viewer.userId, role: 'client_viewer' },
    foreignAdmin: { userId: foreignAdmin.userId, role: 'agency_admin' },
    platformAdminMember: { userId: platformAdminUser.id, role: 'client_viewer' },
    platformAdminOutsider: platformAdminOutsider.id,
    outsider: outsider.id,
  };

  service = createAuthorizationService({
    db: database.runtime.db,
    store: createMembershipStore(database.runtime.db),
  });
}, 240_000);

afterAll(async () => {
  await database?.close();
});

describe('the tenant context lifecycle', () => {
  it('has no tenant context before authorization', async () => {
    expect(await readCurrentOrganizationId(database.runtime.db)).toBeNull();
  });

  it('establishes a transaction-local context only after membership is proven', async () => {
    const seen = await service.withAuthorizedOrganization(
      { userId: fixture.admin.userId },
      fixture.orgA,
      async (session) => {
        const result = await session.repositories.organizations.getCurrent();
        expect(result?.id).toBe(fixture.orgA);
        return session.context.organizationId;
      },
    );

    expect(seen).toBe(fixture.orgA);
  });

  it('clears the context after commit', async () => {
    await service.withAuthorizedOrganization(
      { userId: fixture.admin.userId },
      fixture.orgA,
      async (session) => session.repositories.clients.list(),
    );

    expect(await readCurrentOrganizationId(database.runtime.db)).toBeNull();
  });

  it('clears the context after rollback', async () => {
    await expect(
      service.withAuthorizedOrganization(
        { userId: fixture.admin.userId },
        fixture.orgA,
        async () => {
          await Promise.resolve();
          throw new Error('rolled back on purpose');
        },
      ),
    ).rejects.toThrow('rolled back on purpose');

    expect(await readCurrentOrganizationId(database.runtime.db)).toBeNull();
  });

  it('never opens a transaction when membership fails', async () => {
    // The refusal happens before any tenant context could exist, and the pooled
    // connection is left as clean as it was found.
    await expect(
      service.withAuthorizedOrganization({ userId: fixture.outsider }, fixture.orgA, async () =>
        Promise.resolve('unreachable'),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);

    expect(await readCurrentOrganizationId(database.runtime.db)).toBeNull();
  });

  it('sets the context from the verified membership, not from the request', async () => {
    const observed = await service.withAuthorizedOrganization(
      { userId: fixture.admin.userId },
      fixture.orgA,
      async (session) => {
        // Row Level Security is what answers here: the organization row is visible
        // only because app.current_org_id equals the authorized organization. There
        // is no path by which a request value could have set it to something else.
        const organization = await session.repositories.organizations.getCurrent();
        return { id: organization?.id, authorized: session.context.organizationId };
      },
    );

    expect(observed.id).toBe(fixture.orgA);
    expect(observed.authorized).toBe(fixture.orgA);
  });
});

describe('membership is required, and only membership authorizes', () => {
  it('refuses a user with no membership anywhere', async () => {
    await expect(
      service.withAuthorizedOrganization({ userId: fixture.outsider }, fixture.orgA, async () =>
        Promise.resolve(null),
      ),
    ).rejects.toMatchObject({ failure: 'no_membership' });
  });

  it('refuses a member of another organization', async () => {
    await expect(
      service.withAuthorizedOrganization(
        { userId: fixture.foreignAdmin.userId },
        fixture.orgA,
        async () => Promise.resolve(null),
      ),
    ).rejects.toMatchObject({ failure: 'no_membership' });
  });

  it('refuses a forged organization id', async () => {
    for (const forged of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      await expect(
        service.withAuthorizedOrganization({ userId: fixture.admin.userId }, forged, async () =>
          Promise.resolve(null),
        ),
      ).rejects.toBeInstanceOf(AuthorizationError);
    }
  });

  it("lists only the caller's own organizations", async () => {
    const listed = await service.listOrganizations({ userId: fixture.admin.userId });

    expect(listed.map((row) => row.organizationId)).toEqual([fixture.orgA]);
    expect(await service.listOrganizations({ userId: fixture.outsider })).toEqual([]);
  });
});

describe('platform administration does not bypass organization policy', () => {
  it('grants a platform admin nothing without a membership', async () => {
    await expect(
      service.withAuthorizedOrganization(
        { userId: fixture.platformAdminOutsider },
        fixture.orgA,
        async () => Promise.resolve(null),
      ),
    ).rejects.toMatchObject({ failure: 'no_membership' });
  });

  it('leaves a platform admin with exactly its organization role', async () => {
    await service.withAuthorizedOrganization(
      { userId: fixture.platformAdminMember.userId },
      fixture.orgA,
      (session) => {
        expect(session.context.role).toBe('client_viewer');
        expect(session.can('client.read')).toBe(true);
        // The flag is not consulted anywhere in the authorization path.
        expect(session.can('member.read')).toBe(false);
        expect(session.can('client.create')).toBe(false);
        expect(() => {
          session.require('member.remove');
        }).toThrow(AuthorizationError);
        return Promise.resolve(null);
      },
    );
  });

  it('does not expose the platform flag through the authorization context', async () => {
    await service.withAuthorizedOrganization(
      { userId: fixture.platformAdminMember.userId },
      fixture.orgA,
      (session) => {
        expect(Object.keys(session.context).sort()).toEqual([
          'authorizedAt',
          'clientAccessMode',
          'membershipId',
          'organizationId',
          'registryVersion',
          'role',
          'userId',
        ]);
        return Promise.resolve(null);
      },
    );
  });
});

describe('role permissions inside a real transaction', () => {
  const expectations: { actor: string; pick: () => Actor; permitted: boolean }[] = [
    { actor: 'admin', pick: () => fixture.admin, permitted: true },
    { actor: 'manager', pick: () => fixture.manager, permitted: false },
    { actor: 'editor', pick: () => fixture.editor, permitted: false },
    { actor: 'analyst', pick: () => fixture.analyst, permitted: false },
    { actor: 'viewer', pick: () => fixture.viewer, permitted: false },
  ];

  it.each(expectations)('$actor may create a client: $permitted', async ({ pick, permitted }) => {
    await service.withAuthorizedOrganization({ userId: pick().userId }, fixture.orgA, (session) => {
      expect(session.can('client.create')).toBe(permitted);

      if (permitted) {
        expect(() => {
          session.require('client.create');
        }).not.toThrow();
      } else {
        expect(() => {
          session.require('client.create');
        }).toThrow(AuthorizationError);
      }

      // Every role can read the organization it is a member of.
      expect(session.can('organization.read')).toBe(true);
      return Promise.resolve(null);
    });
  });

  it('reports the registry version that produced the decision', async () => {
    await service.withAuthorizedOrganization(
      { userId: fixture.admin.userId },
      fixture.orgA,
      (session) => {
        expect(session.context.registryVersion).toBe(1);
        return Promise.resolve(null);
      },
    );
  });
});

describe('client access mode', () => {
  it('all_clients reaches every client of the organization', async () => {
    await service.withAuthorizedOrganization(
      { userId: fixture.editor.userId },
      fixture.orgA,
      async (session) => {
        expect(session.context.clientAccessMode).toBe('all_clients');

        const first = await session.requireClient('client.read', fixture.clientA1);
        const second = await session.requireClient('client.read', fixture.clientA2);

        expect(first.clientId).toBe(fixture.clientA1);
        expect(second.clientId).toBe(fixture.clientA2);
        return null;
      },
    );
  });

  it('scoped reaches a listed client', async () => {
    await service.withAuthorizedOrganization(
      { userId: fixture.manager.userId },
      fixture.orgA,
      async (session) => {
        const authorized = await session.requireClient('client.read', fixture.clientA1);
        expect(authorized.clientId).toBe(fixture.clientA1);
        return null;
      },
    );
  });

  it('scoped cannot reach an unlisted client of its own organization', async () => {
    await service.withAuthorizedOrganization(
      { userId: fixture.manager.userId },
      fixture.orgA,
      async (session) => {
        await expect(session.requireClient('client.read', fixture.clientA2)).rejects.toMatchObject({
          failure: 'client_out_of_scope',
        });
        return null;
      },
    );
  });

  it('scoped with zero scope rows reaches zero clients', async () => {
    // The case the access mode exists for: an empty collection is never "all".
    await service.withAuthorizedOrganization(
      { userId: fixture.analyst.userId },
      fixture.orgA,
      async (session) => {
        expect(session.context.clientAccessMode).toBe('scoped');
        expect(await session.listScopedClientIds()).toEqual(new Set());

        for (const clientId of [fixture.clientA1, fixture.clientA2]) {
          await expect(session.requireClient('client.read', clientId)).rejects.toMatchObject({
            failure: 'client_out_of_scope',
          });
        }
        return null;
      },
    );
  });

  it('refuses a client of another organization even for an all_clients admin', async () => {
    await service.withAuthorizedOrganization(
      { userId: fixture.admin.userId },
      fixture.orgA,
      async (session) => {
        await expect(session.requireClient('client.read', fixture.clientB1)).rejects.toMatchObject({
          failure: 'resource_not_in_organization',
        });
        return null;
      },
    );
  });

  it('refuses a guessed or malformed client id', async () => {
    await service.withAuthorizedOrganization(
      { userId: fixture.admin.userId },
      fixture.orgA,
      async (session) => {
        for (const guessed of [
          '00000000-0000-4000-8000-000000000000',
          'not-a-uuid',
          "' OR 1=1 --",
        ]) {
          await expect(session.requireClient('client.read', guessed)).rejects.toMatchObject({
            failure: 'resource_not_in_organization',
          });
        }
        return null;
      },
    );
  });

  it('checks the role before it looks at any client', async () => {
    // A role that cannot hold the permission is refused without the client being
    // looked up at all, so the refusal reveals nothing about which clients exist.
    await service.withAuthorizedOrganization(
      { userId: fixture.viewer.userId },
      fixture.orgA,
      async (session) => {
        await expect(
          session.requireClient('client.update', fixture.clientA2),
        ).rejects.toMatchObject({ failure: 'permission_denied' });
        return null;
      },
    );
  });

  it('cannot be given a cross-organization scope row', async () => {
    // The composite foreign keys from migration 0001 make it structurally impossible
    // to scope an organization A membership to an organization B client.
    await service.withAuthorizedOrganization(
      { userId: fixture.admin.userId },
      fixture.orgA,
      async (session) => {
        const memberships = await session.repositories.memberships.list();
        const target = memberships.find((row) => row.userId === fixture.manager.userId);
        expect(target).toBeDefined();

        await expect(
          session.repositories.membershipClientScopes.add({
            membershipId: target?.id ?? '',
            clientId: fixture.clientB1,
          }),
        ).rejects.toThrow();
        return null;
      },
    );
  });
});

describe('database-enforced invariants', () => {
  it('refuses an organization-wide client_viewer', async () => {
    await expect(
      provisionMembership(database.provisioner.db, {
        organizationId: fixture.orgB,
        userId: fixture.outsider,
        role: 'client_viewer',
        clientAccessMode: 'all_clients',
      }),
      // The driver error names the constraint; the ORM wraps it, so assert on the
      // cause rather than on the wrapper's message.
    ).rejects.toMatchObject({ cause: { constraint: 'memberships_client_viewer_is_scoped' } });
  });

  it('keeps the bootstrap policy inert inside a tenant transaction', async () => {
    // Establishing both settings at once must not let a tenant query see membership
    // rows from another organization: the bootstrap policy requires
    // app.current_org_id() to be NULL.
    const rows = await database.runtime.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_org_id', ${fixture.orgA}, true)`);
      await tx.execute(
        sql`SELECT set_config('app.authz_user_id', ${fixture.foreignAdmin.userId}, true)`,
      );

      const result = await tx.execute<{ organization_id: string }>(
        sql`SELECT DISTINCT organization_id FROM memberships`,
      );

      return result.rows.map((row) => row.organization_id);
    });

    expect(rows).toEqual([fixture.orgA]);
    expect(rows).not.toContain(fixture.orgB);
  });
});

describe('membership changes are observed on the next authorization', () => {
  it('fails authorization after the membership is removed', async () => {
    const user = await provisionUser(database.provisioner.db, {
      email: 'authz-transient@example.test',
      name: 'Transient',
    });
    const membership = await provisionMembership(database.provisioner.db, {
      organizationId: fixture.orgA,
      userId: user.id,
      role: 'analyst',
      clientAccessMode: 'all_clients',
    });

    await service.withAuthorizedOrganization({ userId: user.id }, fixture.orgA, (session) => {
      expect(session.context.role).toBe('analyst');
      return Promise.resolve(null);
    });

    // Removed by an administrator of the organization, through ordinary repositories.
    await service.withAuthorizedOrganization(
      { userId: fixture.admin.userId },
      fixture.orgA,
      async (session) => {
        expect(await session.repositories.memberships.delete(membership.id)).toBe(true);
        return null;
      },
    );

    await expect(
      service.withAuthorizedOrganization({ userId: user.id }, fixture.orgA, async () =>
        Promise.resolve(null),
      ),
    ).rejects.toMatchObject({ failure: 'no_membership' });
  });

  it('observes a role change and a scope change on the next authorization', async () => {
    const user = await provisionUser(database.provisioner.db, {
      email: 'authz-changing@example.test',
      name: 'Changing',
    });
    const membership = await provisionMembership(database.provisioner.db, {
      organizationId: fixture.orgA,
      userId: user.id,
      role: 'agency_admin',
      clientAccessMode: 'all_clients',
    });

    await service.withAuthorizedOrganization({ userId: user.id }, fixture.orgA, async (session) => {
      expect(session.can('client.create')).toBe(true);
      await expect(session.requireClient('client.read', fixture.clientA1)).resolves.toBeDefined();
      return null;
    });

    await service.withAuthorizedOrganization(
      { userId: fixture.admin.userId },
      fixture.orgA,
      async (session) => {
        await session.repositories.memberships.updateRole(membership.id, 'analyst');
        await session.repositories.memberships.updateClientAccessMode(membership.id, 'scoped');
        return null;
      },
    );

    await service.withAuthorizedOrganization({ userId: user.id }, fixture.orgA, async (session) => {
      expect(session.context.role).toBe('analyst');
      expect(session.context.clientAccessMode).toBe('scoped');
      expect(session.can('client.create')).toBe(false);
      // Scoped with no scope rows: zero clients, immediately.
      await expect(session.requireClient('client.read', fixture.clientA1)).rejects.toMatchObject({
        failure: 'client_out_of_scope',
      });
      return null;
    });
  });
});
