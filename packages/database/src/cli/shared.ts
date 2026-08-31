import { createLogger, type Logger } from '@organic-os/observability';

/**
 * CLI plumbing shared by the database commands.
 *
 * Connection strings contain credentials, so nothing here ever logs a URL — only the
 * credential-free description produced by `describeConnection()`.
 */
export function createCliLogger(name: string): Logger {
  return createLogger({ name, level: process.env['LOG_LEVEL'] === 'debug' ? 'debug' : 'info' });
}

export function reportFailure(logger: Logger, message: string, error: unknown): never {
  logger.error(
    {
      errorName: error instanceof Error ? error.name : 'Error',
      errorMessage: error instanceof Error ? error.message : 'unknown error',
      cause:
        error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
    },
    message,
  );

  process.exitCode = 1;
  process.exit(1);
}
