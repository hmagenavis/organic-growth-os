import { z } from 'zod';

import { parseDatabaseEnv } from '../config.js';
import { verifyStagingEnvironment, type StagingCheck } from '../staging/verify.js';
import { createCliLogger, reportFailure } from './shared.js';

/**
 * `pnpm db:verify:staging` — does the managed staging database actually give us the
 * environment the architecture assumes?
 *
 * This is not a substitute for the disposable CI suite, which proves the *logic* from
 * migration 0001 on every run (docs/TESTING.md §2). It proves the *platform*:
 * extensions, role attributes, FORCE RLS, grants, and — the one that cannot be
 * checked any other way — that the connection mode in front of the database really
 * does keep `set_config(..., true)` inside its transaction.
 *
 * Every check is a catalog read or runs inside a rolled-back transaction. Nothing is
 * committed, seeded or deleted.
 *
 * `STAGING_DB_HOST` is mandatory and must match the host in every supplied connection
 * string. It exists so a mistyped or stale environment cannot silently point this at a
 * database nobody meant to touch.
 */

const logger = createCliLogger('db:verify:staging');

const stagingEnvSchema = z.object({
  /** The host the operator is asserting they mean to verify. */
  STAGING_DB_HOST: z.string().min(1),
  /** The RLS-constrained application connection — the one the API will really use. */
  STAGING_DATABASE_URL: z.string().min(1),
  /** Optional: enables the migration-state and checksum checks. */
  STAGING_DATABASE_MIGRATOR_URL: z.string().min(1).optional(),
  STAGING_DATABASE_PROVISIONER_URL: z.string().min(1).optional(),
});

function symbolFor(check: StagingCheck): string {
  switch (check.status) {
    case 'pass':
      return 'PASS';
    case 'fail':
      return 'FAIL';
    case 'skipped':
      return 'SKIP';
  }
}

async function main(): Promise<void> {
  const env = parseDatabaseEnv(stagingEnvSchema);

  // Only the host is ever logged. Connection strings carry credentials.
  logger.info({ host: env.STAGING_DB_HOST }, 'verifying staging database environment');

  const result = await verifyStagingEnvironment({
    runtimeUrl: env.STAGING_DATABASE_URL,
    migratorUrl: env.STAGING_DATABASE_MIGRATOR_URL,
    provisionerUrl: env.STAGING_DATABASE_PROVISIONER_URL,
    expectedHost: env.STAGING_DB_HOST,
  });

  for (const check of result.checks) {
    const line = { check: check.id, outcome: symbolFor(check), detail: check.detail };

    if (check.status === 'fail') {
      logger.error(line, check.title);
    } else {
      logger.info(line, check.title);
    }
  }

  logger.info(
    { passed: result.passed, failed: result.failed, skipped: result.skipped },
    'staging verification complete',
  );

  if (result.failed > 0) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  reportFailure(logger, 'staging verification failed', error);
});
