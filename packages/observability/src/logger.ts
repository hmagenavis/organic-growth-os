import { pino, type LoggerOptions } from 'pino';

import { DEFAULT_REDACT_PATHS, REDACTION_CENSOR } from './redaction.js';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

/**
 * Sink for serialized log records. Declared here so consumers never need to depend on
 * the logging backend's own types.
 */
export interface LogDestination {
  write(chunk: string): void;
}

export interface LogFn {
  (details: Record<string, unknown>, message?: string): void;
  (message: string): void;
}

/**
 * The logging surface the rest of the system programs against.
 *
 * Packages depend on this interface rather than on pino directly, so the backend can
 * be replaced without touching call sites (docs/ARCHITECTURE.md §8).
 */
export interface Logger {
  readonly level: string;
  fatal: LogFn;
  error: LogFn;
  warn: LogFn;
  info: LogFn;
  debug: LogFn;
  trace: LogFn;
  child(bindings: Record<string, unknown>): Logger;
}

export interface CreateLoggerOptions {
  /** Service name attached to every record, e.g. `api`. */
  name: string;
  level?: LogLevel;
  /** Additional fields attached to every record. Never put secrets here. */
  bindings?: Record<string, unknown>;
  /** Overrides the default censored paths. Extend rather than replace when possible. */
  redactPaths?: readonly string[];
}

/**
 * Creates a structured JSON logger with redaction enabled.
 *
 * @param destination Optional sink; defaults to stdout. Used by tests to capture output.
 */
export function createLogger(options: CreateLoggerOptions, destination?: LogDestination): Logger {
  const { name, level = 'info', bindings, redactPaths = DEFAULT_REDACT_PATHS } = options;

  const loggerOptions: LoggerOptions = {
    level,
    base: { service: name, ...bindings },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    redact: {
      paths: [...redactPaths],
      censor: REDACTION_CENSOR,
    },
  };

  return destination === undefined ? pino(loggerOptions) : pino(loggerOptions, destination);
}
