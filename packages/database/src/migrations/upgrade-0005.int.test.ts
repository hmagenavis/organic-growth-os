import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { bootstrapDatabase, ROLE_NAMES } from '../bootstrap.js';
import { TEST_ROLE_PASSWORDS } from '../testing/database.js';
import { loadMigrationFiles, type MigrationFile } from './runner.js';

/**
 * Upgrading a database that already carries Phase 0.4.1 data.
 *
 * The empty-database path is covered by `migrations.int.test.ts`. This one starts at
 * the 0004 schema with real rows in it, applies 0005, and checks the two things that
 * matter about an additive migration: that existing data is untouched, and that
 * nothing was relaxed on the way.
 *
 * `FORCE ROW LEVEL SECURITY` gets its own assertion here even though 0005 never lifts
 * it. 0004 had to, for a backfill the migrator could not otherwise perform, and the
 * risk of that exception is that it quietly becomes a habit. Asserting
 * `relforcerowsecurity` after *every* migration is what stops it from becoming one.
 */

const DATABASE_NAME = 'organic_os_upgrade_0005_test';

let adminPool: Pool;
let migratorPool: Pool;
let runtimePool: Pool;
let files: MigrationFile[];

let organizationId: string;
let membershipId: string;

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
  runtimePool = new Pool({
    connectionString: withRole(adminUrl, ROLE_NAMES.runtime, TEST_ROLE_PASSWORDS.runtime),
    max: 1,
  });

  files = await loadMigrationFiles();

  // The Phase 0.4.1 schema, exactly.
  for (const version of ['0001', '0002', '0003', '0004']) {
    await apply(migratorPool, version);
  }

  // Data a Phase 0.4.1 deployment could plausibly hold, including an audit row —
  // which is the table 0005 alters, and the one that must survive untouched.
  const organization = await adminPool.query<{ id: string }>(
    "INSERT INTO organizations (id, name, slug) VALUES (gen_random_uuid(), 'Existing', 'existing') RETURNING id",
  );
  organizationId = organization.rows[0]?.id ?? '';

  const user = await adminPool.query<{ id: string }>(
    "INSERT INTO users (id, email, name) VALUES (gen_random_uuid(), 'existing@example.test', 'Existing') RETURNING id",
  );

  const membership = await adminPool.query<{ id: string }>(
    `INSERT INTO memberships (id, organization_id, user_id, role, client_access_mode)
     VALUES (gen_random_uuid(), $1, $2, 'agency_admin', 'all_clients') RETURNING id`,
    [organizationId, user.rows[0]?.id ?? ''],
  );
  membershipId = membership.rows[0]?.id ?? '';

  await adminPool.query(
    `INSERT INTO audit_logs (id, organization_id, actor_kind, actor_id, action, target_type, source, result)
     VALUES (gen_random_uuid(), $1, 'user', $2, 'legacy.event', 'organization', 'api', 'ok')`,
    [organizationId, user.rows[0]?.id ?? ''],
  );
}, 240_000);

afterAll(async () => {
  await runtimePool?.end();
  await migratorPool?.end();
  await adminPool?.end();
});

describe('applying 0005 to a populated 0004 database', () => {
  it('applies without error', async () => {
    await expect(apply(migratorPool, '0005')).resolves.toBeUndefined();
  });

  it('adds actor_membership_id as a nullable column', async () => {
    const result = await adminPool.query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type FROM information_schema.columns
       WHERE table_name = 'audit_logs' AND column_name = 'actor_membership_id'`,
    );

    expect(result.rows[0]).toEqual({ is_nullable: 'YES', data_type: 'uuid' });
  });

  it('leaves the pre-existing audit row intact, with a null membership', async () => {
    const result = await adminPool.query<{
      action: string;
      actor_membership_id: string | null;
    }>('SELECT action, actor_membership_id FROM audit_logs WHERE organization_id = $1', [
      organizationId,
    ]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.action).toBe('legacy.event');
    expect(result.rows[0]?.actor_membership_id).toBeNull();
  });

  it('adds no foreign key, so a removal cannot delete its own audit record', async () => {
    const result = await adminPool.query<{ conname: string }>(
      `SELECT c.conname
       FROM pg_constraint c
       WHERE c.conrelid = 'audit_logs'::regclass AND c.contype = 'f'`,
    );

    expect(result.rows).toEqual([]);
  });

  it('lets the runtime role write the new column under a tenant context', async () => {
    const client = await runtimePool.connect();

    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_org_id', $1, true)", [organizationId]);
      await client.query(
        `INSERT INTO audit_logs (id, organization_id, actor_kind, actor_id, actor_membership_id,
                                 action, target_type, source, result)
         VALUES (gen_random_uuid(), $1, 'user', $2, $3, 'membership.created', 'membership', 'api', 'ok')`,
        [organizationId, membershipId, membershipId],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const result = await adminPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM audit_logs WHERE actor_membership_id IS NOT NULL',
    );

    expect(result.rows[0]?.count).toBe('1');
  });

  it('still refuses UPDATE and DELETE on audit_logs from the runtime role', async () => {
    await expect(runtimePool.query("UPDATE audit_logs SET action = 'tampered'")).rejects.toThrow();
    await expect(runtimePool.query('DELETE FROM audit_logs')).rejects.toThrow();
  });

  it('keeps FORCE ROW LEVEL SECURITY on every tenant table', async () => {
    const result = await adminPool.query<{ relname: string; relforcerowsecurity: boolean }>(
      `SELECT relname, relforcerowsecurity
       FROM pg_class
       WHERE relnamespace = 'public'::regnamespace
         AND relname IN ('organizations', 'users', 'memberships', 'membership_client_scopes',
                         'clients', 'sites', 'site_settings', 'integrations',
                         'integration_tokens', 'audit_logs')
       ORDER BY relname`,
    );

    expect(result.rows).toHaveLength(10);
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

  it('granted the runtime role nothing new on organizations or users', async () => {
    const result = await adminPool.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type
       FROM information_schema.table_privileges
       WHERE grantee = 'organic_os_runtime' AND table_name IN ('organizations', 'users')
       ORDER BY table_name, privilege_type`,
    );

    expect(result.rows).toEqual([
      { table_name: 'organizations', privilege_type: 'SELECT' },
      { table_name: 'organizations', privilege_type: 'UPDATE' },
      { table_name: 'users', privilege_type: 'SELECT' },
      // Column-scoped UPDATE on last_login_at (0003) does not appear as a table
      // privilege, which is exactly the point: the runtime role holds no table-wide
      // UPDATE on `users`.
    ]);
  });
});
