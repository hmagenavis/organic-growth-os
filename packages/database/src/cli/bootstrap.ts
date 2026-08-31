import { bootstrapDatabase } from '../bootstrap.js';
import { bootstrapDatabaseEnvSchema, describeConnection, parseDatabaseEnv } from '../config.js';
import { createCliLogger, reportFailure } from './shared.js';

const logger = createCliLogger('db:bootstrap');

async function main(): Promise<void> {
  const env = parseDatabaseEnv(bootstrapDatabaseEnvSchema);

  logger.info(describeConnection(env.DATABASE_ADMIN_URL), 'bootstrapping database');

  await bootstrapDatabase({
    adminUrl: env.DATABASE_ADMIN_URL,
    passwords: {
      migrator: env.DATABASE_MIGRATOR_PASSWORD,
      runtime: env.DATABASE_RUNTIME_PASSWORD,
      provisioner: env.DATABASE_PROVISIONER_PASSWORD,
    },
  });

  logger.info({}, 'extensions and roles are in place');
}

void main().catch((error: unknown) => {
  reportFailure(logger, 'bootstrap failed', error);
});
