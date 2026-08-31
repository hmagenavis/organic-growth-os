import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { bootstrapDatabase, ROLE_NAMES } from '../bootstrap.js';
import { TEST_ROLE_PASSWORDS } from '../testing/database.js';
import { loadMigrationFiles, type MigrationFile } from './runner.js';

/**
 * Upgrading a database that already carries Phase 0.3 data.
 *
 * The empty-database path is covered by `migrations.int.test.ts`. This one starts at
 * the 0003 schema, puts realistic membership rows in it, then applies 0004 and checks
 * what the backfill decided — because a backfill that silently widens access is the
 * failure mode that matters and it cannot be observed on an empty database.
 */

const DATABASE_NAME = 'organic_os_upgrade_0004_test';

let adminPool: Pool;
let migratorPool: Pool;
let files: MigrationFile[];

interface Seeded {
  adminMembership: string;
  managerWithScopes: string;
  managerWithoutScopes: string;
  viewerWithoutScopes: string;
}

let seeded: Seeded;

function withDatabaseName(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function withRole(url: string, role: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(role);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

async function apply(pool: Pool, version: string): Promise<void> {
  const file = files.find((candidate) => candidate.version === version);

  if (file === undefined) {
    throw new Error(`Migration ${version} not found`);
  }

  await pool.query(file.sql);
}

beforeAll(async () => {
  const adminUri = inject('postgresAdminUri');
  const server = new Client({ connectionString: adminUri });
  await server.connect();

  try {
    await server.query(`DROP DATABASE IF EXISTS "${DATABASE_NAME}" WITH (FORCE)`);
    await server.query(`CREATE DATABASE "${DATABASE_NAME}"`);
  } finally {
    await server.end();
  }

  const adminUrl = withDatabaseName(adminUri, DATABASE_NAME);
  await bootstrapDatabase({ adminUrl, passwords: { ...TEST_ROLE_PASSWORDS } });

  adminPool = new Pool({ connectionString: adminUrl, max: 1 });
  migratorPool = new Pool({
    connectionString: withRole(adminUrl, ROLE_NAMES.migrator, TEST_ROLE_PASSWORDS.migrator),
    max: 1,
  });

  files = await loadMigrationFiles();

  // The Phase 0.3 schema, exactly.
  await apply(migratorPool, '0001');
  await apply(migratorPool, '0002');
  await apply(migratorPool, '0003');

  // Data a Phase 0.3 deployment could plausibly hold. Written on the superuser
  // connection because Row Level Security is forced for every other role and this is
  // standing in for rows that pre-date the migration.
  const organization = await adminPool.query<{ id: string }>(
    "INSERT INTO organizations (id, name, slug) VALUES (gen_random_uuid(), 'Legacy', 'legacy') RETURNING id",
  );
  const organizationId = organization.rows[0]?.id ?? '';

  const client = await adminPool.query<{ id: string }>(
    'INSERT INTO clients (id, organization_id, name) VALUES (gen_random_uuid(), $1, $2) RETURNING id',
    [organizationId, 'Legacy Client'],
  );
  const clientId = client.rows[0]?.id ?? '';

  async function seedMembership(handle: string, role: string): Promise<string> {
    const user = await adminPool.query<{ id: string }>(
      'INSERT INTO users (id, email, name) VALUES (gen_random_uuid(), $1, $2) RETURNING id',
      [`${handle}@example.test`, handle],
    );

    const membership = await adminPool.query<{ id: string }>(
      'INSERT INTO memberships (id, organization_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id',
      [organizationId, user.rows[0]?.id ?? '', role],
    );

    return membership.rows[0]?.id ?? '';
  }

  const adminMembership = await seedMembership('legacy-admin', 'agency_admin');
  const managerWithScopes = await seedMembership('legacy-manager-scoped', 'seo_manager');
  const managerWithoutScopes = await seedMembership('legacy-manager-open', 'seo_manager');
  // A client_viewer with no scope rows: permissive under the old convention, which is
  // exactly the row the backfill has to narrow.
  const viewerWithoutScopes = await seedMembership('legacy-viewer', 'client_viewer');

  await adminPool.query(
    'INSERT INTO membership_client_scopes (id, organization_id, membership_id, client_id) VALUES (gen_random_uuid(), $1, $2, $3)',
    [organizationId, managerWithScopes, clientId],
  );

  seeded = { adminMembership, managerWithScopes, managerWithoutScopes, viewerWithoutScopes };
}, 240_000);

afterAll(async () => {
  await migratorPool?.end();
  await adminPool?.end();
});

describe('applying 0004 to a populated 0003 database', () => {
  it('applies without error', async () => {
    await expect(apply(migratorPool, '0004')).resolves.toBeUndefined();
  });

  it('backfills a membership with scope rows as scoped', async () => {
    const result = await adminPool.query<{ client_access_mode: string }>(
      'SELECT client_access_mode FROM memberships WHERE id = $1',
      [seeded.managerWithScopes],
    );

    expect(result.rows[0]?.client_access_mode).toBe('scoped');
  });

  it('backfills a membership with no scope rows as all_clients, preserving old behaviour', async () => {
    for (const membershipId of [seeded.adminMembership, seeded.managerWithoutScopes]) {
      const result = await adminPool.query<{ client_access_mode: string }>(
        'SELECT client_access_mode FROM memberships WHERE id = $1',
        [membershipId],
      );

      expect(result.rows[0]?.client_access_mode).toBe('all_clients');
    }
  });

  it('narrows a client_viewer with no scope rows to scoped', async () => {
    // Narrowing, not widening: under the old convention this row reached every client
    // of the organization, which SECURITY.md §3 never intended for client_viewer.
    const result = await adminPool.query<{ client_access_mode: string }>(
      'SELECT client_access_mode FROM memberships WHERE id = $1',
      [seeded.viewerWithoutScopes],
    );

    expect(result.rows[0]?.client_access_mode).toBe('scoped');
  });

  it('leaves no membership without a mode', async () => {
    const result = await adminPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM memberships WHERE client_access_mode IS NULL',
    );

    expect(result.rows[0]?.count).toBe('0');
  });

  it('restores FORCE ROW LEVEL SECURITY on both tables it lifted it from', async () => {
    const result = await adminPool.query<{ relname: string; relforcerowsecurity: boolean }>(
      `SELECT relname, relforcerowsecurity
       FROM pg_class
       WHERE relnamespace = 'public'::regnamespace
         AND relname IN ('memberships', 'membership_client_scopes')
       ORDER BY relname`,
    );

    expect(result.rows).toHaveLength(2);
    for (const table of result.rows) {
      expect(table.relforcerowsecurity, `${table.relname} must force RLS`).toBe(true);
    }
  });

  it('leaves the runtime role without superuser or BYPASSRLS', async () => {
    const result = await adminPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'organic_os_runtime'",
    );

    expect(result.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('created no SECURITY DEFINER function', async () => {
    const result = await adminPool.query<{ proname: string }>(
      `SELECT p.proname
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app' AND p.prosecdef`,
    );

    expect(result.rows).toEqual([]);
  });
});
