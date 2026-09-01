import { Pool } from 'pg';

import { describeConnection, migratorDatabaseEnvSchema, parseDatabaseEnv } from '../config.js';
import { migrate } from '../migrations/runner.js';
import { tlsOptionsFor } from '../tls.js';
import { createCliLogger, reportFailure } from './shared.js';

const logger = createCliLogger('db:migrate');

async function main(): Promise<void> {
  const env = parseDatabaseEnv(migratorDatabaseEnvSchema);
  const pool = new Pool({
    connectionString: env.DATABASE_MIGRATOR_URL,
    max: 1,
    ssl: tlsOptionsFor(env.DATABASE_MIGRATOR_URL),
  });

  logger.info(describeConnection(env.DATABASE_MIGRATOR_URL), 'applying migrations');

  try {
    const result = await migrate(pool);

    if (result.applied.length === 0) {
      logger.info({ alreadyApplied: result.skipped.length }, 'database is up to date');
      return;
    }

    for (const file of result.applied) {
      logger.info({ version: file.version, name: file.name }, 'applied migration');
    }

    logger.info({ applied: result.applied.length }, 'migrations complete');
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  reportFailure(logger, 'migration failed', error);
});
