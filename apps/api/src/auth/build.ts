import {
  createAuthConfig,
  createLoginRateLimiter,
  createLoginService,
  createPasswordHasher,
  createSessionService,
  InMemoryRateLimitStore,
  type AuthConfig,
  type AuthStore,
  type RateLimitStore,
} from '@organic-os/auth';

import type { AuthDependencies } from './context.js';

/**
 * Composition root for authentication.
 *
 * Everything the API needs is assembled here from `@organic-os/auth` primitives and
 * an `AuthStore` supplied by the caller, so the store — the only piece that touches
 * PostgreSQL — can be swapped without any other part of the API knowing.
 */

export interface BuildAuthDependenciesOptions {
  readonly store: AuthStore;
  readonly config: AuthConfig;
  /**
   * Rate-limit backing store. Defaults to the single-process in-memory store; a
   * multi-instance deployment must supply a distributed one (sub-phase 0.5).
   */
  readonly rateLimitStore?: RateLimitStore;
  readonly now?: () => Date;
}

export function buildAuthDependencies(options: BuildAuthDependenciesOptions): AuthDependencies {
  const { store, config } = options;
  const now = options.now ?? ((): Date => new Date());

  const sessions = createSessionService({ store, config, now });
  const passwords = createPasswordHasher(config.passwordHash);
  const rateLimiter = createLoginRateLimiter({
    store: options.rateLimitStore ?? new InMemoryRateLimitStore(),
    config,
    now: () => now().getTime(),
  });

  const logins = createLoginService({ store, sessions, passwords, rateLimiter, now });

  return { config, sessions, logins, rateLimiter };
}

export { createAuthConfig };
