import { z } from 'zod';

import { EnvValidationError, toEnvIssues } from './errors.js';

/**
 * SERVER-ONLY configuration.
 *
 * This module must never be imported from browser-bound code. The package exposes it
 * under the `@organic-os/config/server` subpath (there is no root export), so a client
 * bundle cannot reach it by importing the package name.
 */

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type EnvSource = Readonly<Record<string, string | undefined>>;

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** Reported by health endpoints; set by the deployment pipeline. */
  SERVICE_VERSION: z.string().min(1).default('0.0.0-dev'),

  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * Validates an environment source and returns typed configuration.
 *
 * @throws {EnvValidationError} when any variable is missing or malformed.
 */
export function parseServerEnv(source: EnvSource = process.env): ServerEnv {
  const result = serverEnvSchema.safeParse(source);

  if (!result.success) {
    throw new EnvValidationError(toEnvIssues(result.error.issues));
  }

  return result.data;
}

let cachedServerEnv: ServerEnv | undefined;

/**
 * Process-wide server configuration, validated once on first access (fail-fast).
 */
export function serverEnv(): ServerEnv {
  cachedServerEnv ??= parseServerEnv();
  return cachedServerEnv;
}

export { EnvValidationError, type EnvIssue } from './errors.js';
