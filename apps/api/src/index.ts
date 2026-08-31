import { serverEnv } from '@organic-os/config/server';
import { createLogger } from '@organic-os/observability';

import { buildApp } from './app.js';

async function main(): Promise<void> {
  // Fail fast: an invalid environment must stop the process before it serves traffic.
  const env = serverEnv();

  const logger = createLogger({
    name: 'api',
    level: env.LOG_LEVEL,
    bindings: { version: env.SERVICE_VERSION },
  });

  const app = buildApp({
    logger,
    serviceVersion: env.SERVICE_VERSION,
    startedAt: Date.now(),
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'shutdown requested');

    void app
      .close()
      .then(() => {
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
