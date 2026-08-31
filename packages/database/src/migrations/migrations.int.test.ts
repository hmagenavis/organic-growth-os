import { ORGANIZATION_ROLES } from '@organic-os/authorization';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import * as schema from '../schema/index.js';
import { createTestDatabase, type TestDatabase } from '../testing/database.js';
import { loadMigrationFiles, migrate, migrationStatus, MigrationError } from './runner.js';

/**
 * Migrations, database roles and schema parity — verified against real PostgreSQL.
 */

let database: TestDatabase;
let migratorPool: Pool;

beforeAll(async () => {
  database = await createTestDatabase(inject('postgresAdminUri'), 'organic_os_migrations_test');
  migratorPool = new Pool({ connectionString: database.migratorUrl, max: 1 });
}, 240_000);

afterAll(async () => {
  await migratorPool?.end();
  await database?.close();
});

describe('migrating from an empty database', () => {
  it('applied every committed migration', async () => {
    const entries = await migrationStatus(migratorPool);

    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.every((entry) => entry.state === 'applied')).toBe(true);
    expect(entries[0]?.appliedAt).toBeInstanceOf(Date);
  });

  it('is idempotent when run again', async () => {
    const result = await migrate(migratorPool);

    expect(result.applied).toHaveLength(0);
    expect(result.skipped.length).toBeGreaterThanOrEqual(2);
  });

  it('records a checksum for each applied migration', async () => {
    const result = await migratorPool.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );

    expect(result.rows.length).toBeGreaterThanOrEqual(2);
    expect(result.rows.every((row) => row.checksum.length === 64)).toBe(true);
  });

  it('refuses to proceed when an applied migration was edited afterwards', async () => {
    await migratorPool.query(
      "UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE version = '0001'",
    );

    try {
      await expect(migrate(migratorPool)).rejects.toBeInstanceOf(MigrationError);
      await expect(migrationStatus(migratorPool)).rejects.toBeInstanceOf(MigrationError);
    } finally {
      // Restore the recorded checksum so later assertions run against a sane history.
      const [first] = await loadMigrationFiles();
      await migratorPool.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [
        first?.checksum,
        '0001',
      ]);
    }
  });
});

describe('database roles', () => {
  it('gives the runtime role neither superuser nor BYPASSRLS', async () => {
    const result = await migratorPool.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>(
      `SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
       FROM pg_roles
       WHERE rolname IN ('organic_os_runtime', 'organic_os_provisioner', 'organic_os_migrator')
       ORDER BY rolname`,
    );

    expect(result.rows).toHaveLength(3);

    for (const role of result.rows) {
      expect(role.rolsuper, `${role.rolname} must not be superuser`).toBe(false);
      expect(role.rolbypassrls, `${role.rolname} must not bypass RLS`).toBe(false);
      expect(role.rolcreatedb).toBe(false);
      expect(role.rolcreaterole).toBe(false);
    }
  });

  it('does not let the runtime role change the schema', async () => {
    await expect(
      database.runtime.pool.query('CREATE TABLE runtime_should_not_create (id uuid PRIMARY KEY)'),
    ).rejects.toThrow();

    await expect(
      database.runtime.pool.query('ALTER TABLE clients ADD COLUMN injected text'),
    ).rejects.toThrow();

    await expect(database.runtime.pool.query('DROP TABLE audit_logs')).rejects.toThrow();
  });

  it('does not let the runtime role create organizations or modify users', async () => {
    await expect(
      database.runtime.pool.query(
        "INSERT INTO organizations (id, name, slug) VALUES (gen_random_uuid(), 'x', 'x-org')",
      ),
    ).rejects.toThrow();

    await expect(
      database.runtime.pool.query('UPDATE users SET is_platform_admin = true'),
    ).rejects.toThrow();
  });

  it('keeps audit_logs append-only for the runtime role', async () => {
    await expect(
      database.runtime.pool.query('UPDATE audit_logs SET action = $1', ['x']),
    ).rejects.toThrow();
    await expect(database.runtime.pool.query('DELETE FROM audit_logs')).rejects.toThrow();
  });
});

describe('row level security configuration', () => {
  const tenantScoped = [
    'organizations',
    'users',
    'memberships',
    'membership_client_scopes',
    'clients',
    'sites',
    'site_settings',
    'integrations',
    'integration_tokens',
    'audit_logs',
  ];

  it('enables and forces RLS on every tenant-scoped table', async () => {
    const result = await migratorPool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`,
      [tenantScoped],
    );

    expect(result.rows).toHaveLength(tenantScoped.length);

    for (const table of result.rows) {
      expect(table.relrowsecurity, `${table.relname} must enable RLS`).toBe(true);
      expect(table.relforcerowsecurity, `${table.relname} must force RLS`).toBe(true);
    }
  });

  it('documents the two tables that intentionally have no RLS', async () => {
    const result = await migratorPool.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity
       FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`,
      [['sessions', 'feature_flags']],
    );

    expect(result.rows).toHaveLength(2);
    for (const table of result.rows) {
      expect(table.relrowsecurity, `${table.relname} is not tenant-scoped`).toBe(false);
    }
  });

  it('has the pgvector extension available for later phases', async () => {
    const result = await migratorPool.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('vector', 'citext') ORDER BY extname",
    );

    expect(result.rows.map((row) => row.extname)).toEqual(['citext', 'vector']);
  });
});

describe('authorization schema (migration 0004)', () => {
  it('makes memberships.client_access_mode mandatory and defaultless', async () => {
    // No default: a membership must state its mode, so an omitted decision can never
    // be read as the permissive one (docs/SECURITY.md §3).
    const result = await migratorPool.query<{
      is_nullable: string;
      column_default: string | null;
      udt_name: string;
    }>(
      `SELECT is_nullable, column_default, udt_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'memberships'
         AND column_name = 'client_access_mode'`,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.is_nullable).toBe('NO');
    expect(result.rows[0]?.column_default).toBeNull();
    expect(result.rows[0]?.udt_name).toBe('client_access_mode');
  });

  it('offers exactly two client access modes', async () => {
    const result = await migratorPool.query<{ label: string }>(
      `SELECT e.enumlabel AS label
       FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'client_access_mode'
       ORDER BY e.enumsortorder`,
    );

    expect(result.rows.map((row) => row.label)).toEqual(['all_clients', 'scoped']);
  });

  it('keeps the organization role enum aligned with the authorization registry', async () => {
    const result = await migratorPool.query<{ label: string }>(
      `SELECT e.enumlabel AS label
       FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'membership_role'
       ORDER BY e.enumsortorder`,
    );

    // The database enum and the code registry are two representations of one set.
    expect(result.rows.map((row) => row.label)).toEqual([...ORGANIZATION_ROLES]);
    expect(result.rows.map((row) => row.label)).not.toContain('super_admin');
  });

  it('forbids an organization-wide client_viewer at the database level', async () => {
    const result = await migratorPool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'memberships'::regclass AND conname = 'memberships_client_viewer_is_scoped'`,
    );

    expect(result.rows).toHaveLength(1);
  });

  it('adds the bootstrap policies and nothing wider', async () => {
    const result = await migratorPool.query<{
      tablename: string;
      policyname: string;
      qual: string;
    }>(
      `SELECT tablename, policyname, qual
       FROM pg_policies
       WHERE schemaname = 'public' AND policyname LIKE '%authorization_bootstrap%'
       ORDER BY tablename`,
    );

    expect(result.rows.map((row) => row.tablename)).toEqual(['memberships', 'organizations']);

    for (const policy of result.rows) {
      // Both are gated on there being no tenant context, which is what makes them
      // disjoint from the tenant policies rather than additive to them.
      expect(policy.qual, `${policy.policyname} must be inert under a tenant context`).toContain(
        'current_org_id',
      );
      expect(policy.qual, `${policy.policyname} must key on the caller`).toContain('authz_user_id');
    }
  });

  it('grants the runtime role no new write privilege on memberships or organizations', async () => {
    const result = await migratorPool.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type
       FROM information_schema.role_table_grants
       WHERE grantee = 'organic_os_runtime' AND table_name IN ('organizations')
       ORDER BY privilege_type`,
    );

    // 0002 granted SELECT and UPDATE on organizations; 0004 added no more.
    expect(result.rows.map((row) => row.privilege_type).sort()).toEqual(['SELECT', 'UPDATE']);
  });
});

describe('schema parity', () => {
  // The Drizzle definitions and the hand-written SQL are two representations of one
  // schema; this asserts they never drift apart.
  const tables = [
    schema.organizations,
    schema.users,
    schema.memberships,
    schema.membershipClientScopes,
    schema.sessions,
    schema.clients,
    schema.sites,
    schema.siteSettings,
    schema.featureFlags,
    schema.auditLogs,
    schema.integrations,
    schema.integrationTokens,
  ];

  it('matches every Drizzle table against the migrated database', async () => {
    for (const table of tables) {
      const config = getTableConfig(table);
      const expected = config.columns.map((column) => column.name).sort();

      const result = await migratorPool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [config.name],
      );

      const actual = result.rows.map((row) => row.column_name).sort();

      expect(actual, `columns of ${config.name}`).toEqual(expected);
    }
  });
});
