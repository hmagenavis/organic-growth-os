import { Pool } from 'pg';

import { describeConnection, migratorDatabaseEnvSchema, parseDatabaseEnv } from '../config.js';
import { migrationStatus } from '../migrations/runner.js';
import { tlsOptionsFor } from '../tls.js';
import { createCliLogger, reportFailure } from './shared.js';

const logger = createCliLogger('db:status');

async function main(): Promise<void> {
  const env = parseDatabaseEnv(migratorDatabaseEnvSchema);
  const pool = new Pool({
    connectionString: env.DATABASE_MIGRATOR_URL,
    max: 1,
    ssl: tlsOptionsFor(env.DATABASE_MIGRATOR_URL),
  });

  logger.info(describeConnection(env.DATABASE_MIGRATOR_URL), 'migration status');

  try {
    const entries = await migrationStatus(pool);

    for (const entry of entries) {
      logger.info(
        {
          version: entry.version,
          name: entry.name,
          state: entry.state,
          appliedAt: entry.appliedAt?.toISOString() ?? null,
        },
        entry.state === 'applied' ? 'applied' : 'pending',
      );
    }

    const pending = entries.filter((entry) => entry.state === 'pending').length;
    logger.info({ total: entries.length, pending }, 'status complete');

    if (pending > 0) {
      // Non-zero exit lets deployment checks gate on a database being current.
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  reportFailure(logger, 'status check failed', error);
});
