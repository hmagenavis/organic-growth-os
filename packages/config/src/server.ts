import { z } from 'zod';

import { EnvValidationError, toEnvIssues } from './errors.js';
import { trustProxySchema } from './http.js';
import { allowedOriginsSchema } from './origins.js';

/**
 * SERVER-ONLY configuration.
 *
 * This module must never be imported from browser-bound code. The package exposes it
 * under the `@organic-os/config/server` subpath (there is no root export), so a client
 * bundle cannot reach it by importing the package name.
 */

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Container platforms (Render, Railway, Fly) inject the port to listen on as `PORT`
 * and route to it; the API's own name for that setting is `API_PORT`. `API_PORT` stays
 * authoritative when both are present, so a deployment can always override the
 * platform, and neither name is silently ignored.
 *
 * `API_HOST` gets no such fallback on purpose: it defaults to loopback, and a
 * container must bind `0.0.0.0` deliberately rather than by inheriting a variable.
 */
function applyPlatformPort(source: unknown): unknown {
  if (typeof source !== 'object' || source === null) {
    return source;
  }

  const env = source as Record<string, unknown>;

  if (env.API_PORT !== undefined && env.API_PORT !== '') {
    return source;
  }

  // An empty string is a variable a platform declared and left blank. It means
  // "unset", so it is removed rather than coerced — `Number('')` is 0, and a port of
  // 0 asks the kernel for an arbitrary one.
  const rest = { ...env };
  delete rest.API_PORT;

  return env.PORT === undefined || env.PORT === '' ? rest : { ...rest, API_PORT: env.PORT };
}

const serverEnvObjectSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** Reported by health endpoints; set by the deployment pipeline. */
  SERVICE_VERSION: z.string().min(1).default('0.0.0-dev'),

  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  /**
   * What sits in front of this process, and therefore whether `x-forwarded-for` may be
   * believed. Defaults to `false`: the socket peer, unforgeable, which is what makes
   * `request.ip` usable as the login rate-limit key (docs/SECURITY.md §8).
   */
  API_TRUST_PROXY: trustProxySchema,

  /**
   * Browser origins allowed to make credentialed cross-origin requests. Empty by
   * default — a same-origin deployment needs no grant, and an absent value must never
   * become a permissive one.
   */
  CORS_ALLOWED_ORIGINS: allowedOriginsSchema,

  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
});

export const serverEnvSchema = z.preprocess(applyPlatformPort, serverEnvObjectSchema);

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
export { parseTrustProxy, type TrustProxyConfig } from './http.js';
export { parseAllowedOrigins, parseOrigin } from './origins.js';
