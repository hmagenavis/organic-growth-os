import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { CreateClientInput } from '../repositories/clients.js';
import { createTestDatabase, type TestDatabase } from '../testing/database.js';
import { seedTwoTenants, type SeededTenants } from '../testing/seed.js';
import { InvalidTenantContextError, type TenantContext } from './context.js';
import { withTenantTransaction } from './with-tenant-transaction.js';

/**
 * The tenant isolation suite.
 *
 * Two complete tenants exist throughout. Every assertion asks the same question from
 * a different angle: can organization A reach organization B's data through
 * repositories, raw SQL, a pooled connection, or a forged identifier?
 */

let database: TestDatabase;
let tenants: SeededTenants;

beforeAll(async () => {
  database = await createTestDatabase(inject('postgresAdminUri'), 'organic_os_isolation_test');
  tenants = await seedTwoTenants(database.runtime, database.provisioner);
}, 240_000);

afterAll(async () => {
  await database?.close();
});

/** Runs raw SQL as the runtime role inside a transaction carrying a tenant context. */
async function asTenant<T>(
  organizationId: string | null,
  run: (
    query: (text: string, values?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>,
  ) => Promise<void>,
): Promise<void> {
  const client = await database.runtime.pool.connect();

  try {
    await client.query('BEGIN');

    if (organizationId !== null) {
      await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', organizationId]);
    }

    await run(async (text, values) => {
      const result = await client.query(text, values);
      return { rows: result.rows as T[], rowCount: result.rowCount };
    });

    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe('A. repository isolation', () => {
  it('lists only the current organization’s clients', async () => {
    const clients = await withTenantTransaction(database.runtime.db, tenants.a.tenant, (repos) =>
      repos.clients.list(),
    );

    expect(clients).toHaveLength(1);
    expect(clients[0]?.id).toBe(tenants.a.clientId);
    expect(clients.some((client) => client.id === tenants.b.clientId)).toBe(false);
  });

  it('cannot fetch another organization’s client by id', async () => {
    const found = await withTenantTransaction(database.runtime.db, tenants.a.tenant, (repos) =>
      repos.clients.findById(tenants.b.clientId),
    );

    expect(found).toBeNull();
  });

  it('cannot fetch another organization’s site by id', async () => {
    const found = await withTenantTransaction(database.runtime.db, tenants.a.tenant, (repos) =>
      repos.sites.findById(tenants.b.siteId),
    );

    expect(found).toBeNull();
  });

  it('sees only its own organization record', async () => {
    const organization = await withTenantTransaction(
      database.runtime.db,
      tenants.a.tenant,
      (repos) => repos.organizations.getCurrent(),
    );

    expect(organization?.id).toBe(tenants.a.organization.id);
  });

  it('sees only its own site settings and memberships', async () => {
    const result = await withTenantTransaction(
      database.runtime.db,
      tenants.a.tenant,
      async (repos) => ({
        settings: await repos.siteSettings.findBySiteId(tenants.b.siteId),
        memberships: await repos.memberships.list(),
      }),
    );

    expect(result.settings).toBeNull();
    expect(result.memberships).toHaveLength(1);
    expect(result.memberships[0]?.id).toBe(tenants.a.membershipId);
  });
});

describe('B. raw SQL isolation under the runtime role', () => {
  it('returns only the current organization’s rows', async () => {
    await asTenant<{ id: string }>(tenants.a.organization.id, async (query) => {
      const clients = await query('SELECT id FROM clients');
      const sites = await query('SELECT id FROM sites');
      const organizations = await query('SELECT id FROM organizations');

      expect(clients.rows.map((row) => row.id)).toEqual([tenants.a.clientId]);
      expect(sites.rows.map((row) => row.id)).toEqual([tenants.a.siteId]);
      expect(organizations.rows.map((row) => row.id)).toEqual([tenants.a.organization.id]);
    });
  });

  it('hides another organization’s row even when addressed by primary key', async () => {
    await asTenant<{ id: string }>(tenants.a.organization.id, async (query) => {
      const result = await query('SELECT id FROM clients WHERE id = $1', [tenants.b.clientId]);
      expect(result.rows).toHaveLength(0);
    });
  });
});

describe('C. mutation isolation', () => {
  it('cannot update or delete another organization’s client through repositories', async () => {
    const result = await withTenantTransaction(
      database.runtime.db,
      tenants.a.tenant,
      async (repos) => ({
        updated: await repos.clients.update(tenants.b.clientId, { name: 'hijacked' }),
        deleted: await repos.clients.delete(tenants.b.clientId),
      }),
    );

    expect(result.updated).toBeNull();
    expect(result.deleted).toBe(false);
  });

  it('leaves the victim row untouched', async () => {
    const client = await withTenantTransaction(database.runtime.db, tenants.b.tenant, (repos) =>
      repos.clients.findById(tenants.b.clientId),
    );

    expect(client?.name).toBe('Client B');
  });

  it('affects no rows when raw SQL targets another organization', async () => {
    await asTenant(tenants.a.organization.id, async (query) => {
      const updated = await query('UPDATE clients SET name = $1 WHERE id = $2', [
        'hijacked',
        tenants.b.clientId,
      ]);
      const deleted = await query('DELETE FROM sites WHERE id = $1', [tenants.b.siteId]);

      expect(updated.rowCount).toBe(0);
      expect(deleted.rowCount).toBe(0);
    });
  });

  it('cannot append an audit entry attributed to another organization', async () => {
    await expect(
      asTenant(tenants.a.organization.id, async (query) => {
        await query(
          `INSERT INTO audit_logs (id, organization_id, actor_kind, action, target_type, source, result)
           VALUES (gen_random_uuid(), $1, 'system', 'forged', 'client', 'api', 'ok')`,
          [tenants.b.organization.id],
        );
      }),
    ).rejects.toThrow();
  });
});

describe('D. membership client scope isolation', () => {
  it('accepts a scope inside the same organization', async () => {
    const scope = await withTenantTransaction(database.runtime.db, tenants.a.tenant, (repos) =>
      repos.membershipClientScopes.add({
        membershipId: tenants.a.membershipId,
        clientId: tenants.a.clientId,
      }),
    );

    expect(scope.organizationId).toBe(tenants.a.organization.id);
  });

  it('refuses to scope an organization A membership to an organization B client', async () => {
    await expect(
      withTenantTransaction(database.runtime.db, tenants.a.tenant, (repos) =>
        repos.membershipClientScopes.add({
          membershipId: tenants.a.membershipId,
          clientId: tenants.b.clientId,
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a scope naming another organization’s membership', async () => {
    await expect(
      withTenantTransaction(database.runtime.db, tenants.a.tenant, (repos) =>
        repos.membershipClientScopes.add({
          membershipId: tenants.b.membershipId,
          clientId: tenants.a.clientId,
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a cross-organization scope written directly in SQL', async () => {
    await expect(
      asTenant(tenants.a.organization.id, async (query) => {
        await query(
          `INSERT INTO membership_client_scopes (id, organization_id, membership_id, client_id)
           VALUES (gen_random_uuid(), $1, $2, $3)`,
          [tenants.a.organization.id, tenants.a.membershipId, tenants.b.clientId],
        );
      }),
    ).rejects.toThrow();
  });
});

describe('E. pooled connection safety', () => {
  it('does not carry tenant context into the next use of the same connection', async () => {
    const pool = database.runtime.pool;

    // The pool holds a single connection, so the checkouts below are provably the
    // same physical backend — the condition under which leakage would occur.
    const first = await pool.connect();
    const firstPid = (await first.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
      ?.pid;

    await first.query('BEGIN');
    await first.query('SELECT set_config($1, $2, true)', [
      'app.current_org_id',
      tenants.a.organization.id,
    ]);
    const seenByA = await first.query<{ id: string }>('SELECT id FROM clients');
    expect(seenByA.rows.map((row) => row.id)).toEqual([tenants.a.clientId]);
    await first.query('COMMIT');
    first.release();

    const second = await pool.connect();
    const secondPid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0]?.pid;

    try {
      expect(secondPid).toBe(firstPid);

      const leaked = await second.query<{ organization_id: string | null }>(
        'SELECT app.current_org_id() AS organization_id',
      );
      expect(leaked.rows[0]?.organization_id).toBeNull();

      const withoutContext = await second.query('SELECT id FROM clients');
      expect(withoutContext.rows).toHaveLength(0);

      await second.query('BEGIN');
      await second.query('SELECT set_config($1, $2, true)', [
        'app.current_org_id',
        tenants.b.organization.id,
      ]);
      const seenByB = await second.query<{ id: string }>('SELECT id FROM clients');
      expect(seenByB.rows.map((row) => row.id)).toEqual([tenants.b.clientId]);
      await second.query('COMMIT');
    } finally {
      second.release();
    }
  });

  it('clears tenant context after a rolled-back transaction too', async () => {
    const client = await database.runtime.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_org_id',
        tenants.a.organization.id,
      ]);
      await client.query('ROLLBACK');

      const leaked = await client.query<{ organization_id: string | null }>(
        'SELECT app.current_org_id() AS organization_id',
      );
      expect(leaked.rows[0]?.organization_id).toBeNull();
    } finally {
      client.release();
    }
  });
});

describe('F. missing tenant context fails closed', () => {
  it('rejects an absent or malformed context before touching the database', async () => {
    const invalid = [
      undefined,
      null,
      {},
      { organizationId: 'not-a-uuid', actor: { kind: 'system' } },
      { organizationId: tenants.a.organization.id },
    ];

    for (const candidate of invalid) {
      await expect(
        withTenantTransaction(database.runtime.db, candidate as TenantContext, async () =>
          Promise.resolve('unreachable'),
        ),
      ).rejects.toBeInstanceOf(InvalidTenantContextError);
    }
  });

  it('returns nothing and refuses writes when no context is set', async () => {
    await asTenant(null, async (query) => {
      const clients = await query('SELECT id FROM clients');
      const sites = await query('SELECT id FROM sites');

      expect(clients.rows).toHaveLength(0);
      expect(sites.rows).toHaveLength(0);
    });

    await expect(
      asTenant(null, async (query) => {
        await query(
          `INSERT INTO clients (id, organization_id, name) VALUES (gen_random_uuid(), $1, 'no context')`,
          [tenants.a.organization.id],
        );
      }),
    ).rejects.toThrow();
  });
});

describe('G. forged tenant identifiers confer no authority', () => {
  it('ignores an organization id supplied by the caller', async () => {
    // Simulates an untrusted caller trying to widen its own scope. The repository
    // takes the organization from the tenant context, so the extra field is inert.
    const forged = {
      name: 'Forged Client',
      organizationId: tenants.b.organization.id,
    } as CreateClientInput;

    const created = await withTenantTransaction(database.runtime.db, tenants.a.tenant, (repos) =>
      repos.clients.create(forged),
    );

    expect(created.organizationId).toBe(tenants.a.organization.id);

    const visibleToB = await withTenantTransaction(database.runtime.db, tenants.b.tenant, (repos) =>
      repos.clients.findById(created.id),
    );
    expect(visibleToB).toBeNull();
  });

  it('refuses a row written directly for another organization', async () => {
    await expect(
      asTenant(tenants.a.organization.id, async (query) => {
        await query(
          `INSERT INTO clients (id, organization_id, name) VALUES (gen_random_uuid(), $1, 'forged')`,
          [tenants.b.organization.id],
        );
      }),
    ).rejects.toThrow();
  });

  it('refuses to move an existing row into another organization', async () => {
    await expect(
      asTenant(tenants.a.organization.id, async (query) => {
        await query('UPDATE clients SET organization_id = $1 WHERE id = $2', [
          tenants.b.organization.id,
          tenants.a.clientId,
        ]);
      }),
    ).rejects.toThrow();
  });
});
