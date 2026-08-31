import { serverEnv } from '@organic-os/config/server';
import { createLogger } from '@organic-os/observability';

import { createWorkerRuntime } from './runtime.js';

function main(): void {
  // Fail fast: an invalid environment must stop the process before it takes work.
  const env = serverEnv();

  const logger = createLogger({
    name: 'worker',
    level: env.LOG_LEVEL,
    bindings: { version: env.SERVICE_VERSION },
  });

  const runtime = createWorkerRuntime({
    logger,
    heartbeatIntervalMs: env.WORKER_HEARTBEAT_INTERVAL_MS,
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'shutdown requested');

    void runtime
      .stop()
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

  runtime.start();
}

try {
  main();
} catch (error: unknown) {
  // The logger may not exist yet (configuration itself can be what failed), so report
  // to stderr. Only the message is written — never the environment that produced it.
  const message = error instanceof Error ? error.message : 'unknown error';
  process.stderr.write(`worker failed to start: ${message}\n`);
  process.exitCode = 1;
}
