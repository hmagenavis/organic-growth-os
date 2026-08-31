import { createAuthConfig } from '@organic-os/auth';
import { serverEnv } from '@organic-os/config/server';
import {
  createAuthStore,
  createDatabase,
  parseDatabaseEnv,
  runtimeDatabaseEnvSchema,
  describeConnection,
} from '@organic-os/database';
import { createLogger } from '@organic-os/observability';

import { buildApp } from './app.js';
import { buildAuthDependencies } from './auth/build.js';

async function main(): Promise<void> {
  // Fail fast: an invalid environment must stop the process before it serves traffic.
  // Authentication configuration is validated here too, so a production deployment
  // with insecure cookie settings never reaches the listen call.
  const env = serverEnv();
  const authConfig = createAuthConfig(process.env);
  const databaseEnv = parseDatabaseEnv(runtimeDatabaseEnvSchema);

  const logger = createLogger({
    name: 'api',
    level: env.LOG_LEVEL,
    bindings: { version: env.SERVICE_VERSION },
  });

  // The runtime role: constrained by Row Level Security, unable to create
  // organizations or users. The provisioning and migration connections are not opened
  // by this process at all (docs/SECURITY.md §5).
  const database = createDatabase({
    connectionString: databaseEnv.DATABASE_URL,
    maxConnections: databaseEnv.DATABASE_MAX_CONNECTIONS,
    statementTimeoutMs: databaseEnv.DATABASE_STATEMENT_TIMEOUT_MS,
    idleTransactionTimeoutMs: databaseEnv.DATABASE_IDLE_TX_TIMEOUT_MS,
    applicationName: 'organic-os-api',
  });

  logger.info(
    describeConnection(databaseEnv.DATABASE_URL),
    'database pool opened for the runtime role',
  );

  if (authConfig.nodeEnv === 'production') {
    // An in-memory limiter behind more than one instance is per-instance protection.
    // Say so once, loudly, rather than letting a dashboard imply otherwise.
    logger.warn(
      { distributed: false },
      'login rate limiting is single-process until sub-phase 0.5 introduces a shared store',
    );
  }

  const app = buildApp({
    logger,
    serviceVersion: env.SERVICE_VERSION,
    startedAt: Date.now(),
    auth: buildAuthDependencies({
      store: createAuthStore(database.db),
      config: authConfig,
    }),
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'shutdown requested');

    void app
      .close()
      .then(async () => {
        await database.close();
        logger.info({ signal }, 'shutdown complete');
      })
      .catch((error: unknown) => {
        logger.error(
          { signal, errorMessage: error instanceof Error ? error.message : 'unknown error' },
          'shutdown failed',
        );
        process.exitCode = 1;
      });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  logger.info({ host: env.API_HOST, port: env.API_PORT }, 'api listening');
}

void main().catch((error: unknown) => {
  // The logger may not exist yet (configuration itself can be what failed), so report
  // to stderr. Only the message is written — never the environment that produced it.
  const message = error instanceof Error ? error.message : 'unknown error';
  process.stderr.write(`api failed to start: ${message}\n`);
  process.exitCode = 1;
});
