import { Client, Pool } from 'pg';

import { bootstrapDatabase, ROLE_NAMES } from '../bootstrap.js';
import { createDatabase, type DatabaseHandle } from '../client.js';
import { migrate } from '../migrations/runner.js';

/**
 * Builds an isolated database for one integration test file.
 *
 * Test-only role passwords. These are not secrets: they exist for the lifetime of a
 * throwaway test database and grant nothing outside it.
 */
export const TEST_ROLE_PASSWORDS = {
  migrator: 'test-only-migrator-password',
  runtime: 'test-only-runtime-password',
  provisioner: 'test-only-provisioner-password',
} as const;

export interface TestDatabase {
  readonly databaseName: string;
  readonly adminUrl: string;
  readonly migratorUrl: string;
  readonly runtimeUrl: string;
  readonly provisionerUrl: string;
  /** RLS-constrained handle: what the application itself would use. */
  readonly runtime: DatabaseHandle;
  /** Privileged handle used only to create organizations and users. */
  readonly provisioner: DatabaseHandle;
  close(): Promise<void>;
}

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

/**
 * Creates a fresh database, bootstraps roles and extensions, and runs every
 * migration — the same path a real environment follows.
 */
export async function createTestDatabase(
  adminUri: string,
  databaseName: string,
): Promise<TestDatabase> {
  const server = new Client({ connectionString: adminUri });
  await server.connect();

  try {
    // CREATE/DROP DATABASE cannot run inside a transaction block.
    await server.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await server.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await server.end();
  }

  const adminUrl = withDatabaseName(adminUri, databaseName);

  await bootstrapDatabase({ adminUrl, passwords: { ...TEST_ROLE_PASSWORDS } });

  const migratorUrl = withRole(adminUrl, ROLE_NAMES.migrator, TEST_ROLE_PASSWORDS.migrator);
  const runtimeUrl = withRole(adminUrl, ROLE_NAMES.runtime, TEST_ROLE_PASSWORDS.runtime);
  const provisionerUrl = withRole(
    adminUrl,
    ROLE_NAMES.provisioner,
    TEST_ROLE_PASSWORDS.provisioner,
  );

  const migratorPool = new Pool({ connectionString: migratorUrl, max: 1 });
  try {
    await migrate(migratorPool);
  } finally {
    await migratorPool.end();
  }

  // max: 1 so consecutive transactions provably reuse the same physical connection,
  // which is what makes the pool-leakage test meaningful.
  const runtime = createDatabase({
    connectionString: runtimeUrl,
    maxConnections: 1,
    applicationName: 'organic-os-test-runtime',
  });
  const provisioner = createDatabase({
    connectionString: provisionerUrl,
    maxConnections: 1,
    applicationName: 'organic-os-test-provisioner',
  });

  return {
    databaseName,
    adminUrl,
    migratorUrl,
    runtimeUrl,
    provisionerUrl,
    runtime,
    provisioner,
    close: async (): Promise<void> => {
      await runtime.close();
      await provisioner.close();
    },
  };
}
