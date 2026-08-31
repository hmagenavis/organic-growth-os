import { createAuthConfig, createSessionService } from '@organic-os/auth';
import {
  createAuthStore,
  createDatabase,
  describeConnection,
  parseDatabaseEnv,
  runtimeDatabaseEnvSchema,
} from '@organic-os/database';
import { createLogger } from '@organic-os/observability';

/**
 * Session maintenance: deletes sessions that finished (expired or were revoked)
 * longer ago than the configured grace window.
 *
 * A manually invokable command rather than a scheduled job, because the scheduler is
 * sub-phase 0.5 and introducing BullMQ for one deletion would be building the queue
 * before the thing that needs it. The command is written to be exactly what that
 * scheduler will call:
 *
 *   pnpm sessions:cleanup
 *
 * Idempotent, safe to run concurrently (a DELETE that matches nothing is a no-op),
 * and it uses the ordinary runtime role — no privileged connection is opened.
 */
async function main(): Promise<void> {
  const logger = createLogger({ name: 'session-cleanup' });
  const config = createAuthConfig(process.env);
  const databaseEnv = parseDatabaseEnv(runtimeDatabaseEnvSchema);

  const database = createDatabase({
    connectionString: databaseEnv.DATABASE_URL,
    maxConnections: 1,
    applicationName: 'organic-os-session-cleanup',
  });

  try {
    const sessions = createSessionService({ store: createAuthStore(database.db), config });
    const deleted = await sessions.cleanupFinishedSessions();

    logger.info(
      { deleted, graceMs: config.cleanupGraceMs, ...describeConnection(databaseEnv.DATABASE_URL) },
      'finished sessions removed',
    );
  } finally {
    await database.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown error';
  process.stderr.write(`session cleanup failed: ${message}\n`);
  process.exitCode = 1;
});
