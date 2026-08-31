import { Client, Pool } from 'pg';

import { bootstrapDatabase } from '../bootstrap.js';
import {
  bootstrapDatabaseEnvSchema,
  describeConnection,
  isLocalConnection,
  migratorDatabaseEnvSchema,
  parseDatabaseEnv,
} from '../config.js';
import { migrate } from '../migrations/runner.js';
import { createCliLogger, reportFailure } from './shared.js';

/**
 * Destroys and rebuilds the LOCAL development database.
 *
 * Guarded twice, because this command deletes data:
 *   - it refuses to run unless NODE_ENV is a development or test environment;
 *   - it refuses any connection that is not loopback.
 *
 * There is deliberately no flag that lifts these guards. A production database is
 * repaired with forward migrations and backups, never with a reset command.
 */

const logger = createCliLogger('db:reset');

async function main(): Promise<void> {
  const nodeEnv = process.env['NODE_ENV'] ?? 'development';
  const admin = parseDatabaseEnv(bootstrapDatabaseEnvSchema);
  const migrator = parseDatabaseEnv(migratorDatabaseEnvSchema);

  if (nodeEnv === 'production') {
    throw new Error('db:reset is refused when NODE_ENV=production');
  }

  for (const [label, url] of [
    ['DATABASE_ADMIN_URL', admin.DATABASE_ADMIN_URL],
    ['DATABASE_MIGRATOR_URL', migrator.DATABASE_MIGRATOR_URL],
  ] as const) {
    if (!isLocalConnection(url)) {
      throw new Error(
        `db:reset is refused for a non-local connection (${label} points at ` +
          `${describeConnection(url).host})`,
      );
    }
  }

  const target = describeConnection(admin.DATABASE_ADMIN_URL);
  logger.warn(target, 'dropping and recreating the local development database');

  // DROP/CREATE DATABASE cannot run inside a transaction, and cannot run while
  // connected to the database being dropped — connect to the maintenance database.
  const maintenanceUrl = new URL(admin.DATABASE_ADMIN_URL);
  maintenanceUrl.pathname = '/postgres';

  const server = new Client({ connectionString: maintenanceUrl.toString() });
  await server.connect();

  try {
    await server.query(`DROP DATABASE IF EXISTS "${target.database}" WITH (FORCE)`);
    await server.query(`CREATE DATABASE "${target.database}"`);
  } finally {
    await server.end();
  }

  await bootstrapDatabase({
    adminUrl: admin.DATABASE_ADMIN_URL,
    passwords: {
      migrator: admin.DATABASE_MIGRATOR_PASSWORD,
      runtime: admin.DATABASE_RUNTIME_PASSWORD,
      provisioner: admin.DATABASE_PROVISIONER_PASSWORD,
    },
  });

  const pool = new Pool({ connectionString: migrator.DATABASE_MIGRATOR_URL, max: 1 });
  try {
    const result = await migrate(pool);
    logger.info({ applied: result.applied.length }, 'local database rebuilt');
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  reportFailure(logger, 'reset failed', error);
});
