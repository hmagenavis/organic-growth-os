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
