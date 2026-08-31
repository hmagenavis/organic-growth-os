import { z } from 'zod';

import { AuthConfigError } from './errors.js';
import { DEFAULT_PASSWORD_HASH_PARAMETERS, type PasswordHashParameters } from './password.js';

/**
 * Authentication configuration.
 *
 * Kept in this package rather than `@organic-os/config` for the same reason database
 * configuration lives in `@organic-os/database`: these variables are meaningful only
 * where authentication runs, and processes that never authenticate anyone should not
 * be forced to define them (PHASE-0.2-IMPLEMENTATION.md §12).
 *
 * Security policy lives here and only here — no lifetime, cookie flag or cost
 * parameter is restated at a call site.
 *
 * `AUTH_SESSION_SECRET` is a secret: it is never logged, never returned by an
 * endpoint, and validation reports variable *names* only.
 */

const durationMs = z.coerce
  .number()
  .int()
  .min(60_000)
  .max(90 * 24 * 60 * 60 * 1_000);

export const authEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * Key for the CSRF token MAC. At least 32 characters of high-entropy material,
   * supplied by the secret manager. Rotating it invalidates outstanding CSRF tokens
   * (clients simply fetch a new one); it does not invalidate sessions.
   */
  AUTH_SESSION_SECRET: z.string().min(32),

  /**
   * Absolute session lifetime: how long a session may live no matter how active the
   * user is. Twelve hours means a working day, with re-authentication the next
   * morning — appropriate for a console that can push changes to production sites.
   */
  AUTH_SESSION_ABSOLUTE_LIFETIME_MS: durationMs.default(12 * 60 * 60 * 1_000),

  /** Idle lifetime: how long a session survives without being used. */
  AUTH_SESSION_IDLE_TIMEOUT_MS: durationMs.default(2 * 60 * 60 * 1_000),

  /**
   * Minimum interval between `last_used_at` writes. Without it every authenticated
   * request would issue an UPDATE; the idle window is hours, so minute-granularity
   * activity tracking loses nothing.
   */
  AUTH_SESSION_TOUCH_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(60 * 60 * 1_000)
    .default(60_000),

  /**
   * How long finished sessions (expired or revoked) are kept before the cleanup
   * command deletes them. A short grace window keeps recent rows available for
   * incident investigation.
   */
  AUTH_SESSION_CLEANUP_GRACE_MS: durationMs.default(7 * 24 * 60 * 60 * 1_000),

  /**
   * Forces secure cookies off for local HTTP development. Ignored in production,
   * where insecure cookies are a configuration error rather than an option.
   */
  AUTH_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),

  AUTH_COOKIE_SAME_SITE: z.enum(['lax', 'strict']).default('lax'),

  /** Login attempts counted per source address before the source is throttled. */
  AUTH_LOGIN_RATE_LIMIT_IP_MAX: z.coerce.number().int().min(1).max(10_000).default(20),
  /** Failed attempts counted per account before that account is throttled. */
  AUTH_LOGIN_RATE_LIMIT_ACCOUNT_MAX: z.coerce.number().int().min(1).max(10_000).default(10),
  AUTH_LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(24 * 60 * 60 * 1_000)
    .default(15 * 60 * 1_000),

  /** Argon2id cost. Raise as hardware improves; never lower in production. */
  AUTH_ARGON2_MEMORY_COST_KIB: z.coerce.number().int().min(8_192).max(1_048_576).optional(),
  AUTH_ARGON2_TIME_COST: z.coerce.number().int().min(1).max(20).optional(),
  AUTH_ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(16).optional(),
});

export type AuthEnv = z.infer<typeof authEnvSchema>;

/**
 * Cookie policy for one environment.
 *
 * Production and development are separate *profiles*, not the same profile with a
 * flag turned down: the production names carry the `__Host-` prefix, which browsers
 * only honour for `Secure` cookies with `Path=/` and no `Domain`. Local HTTP
 * development gets its own, differently named cookies, so nothing about making
 * localhost work can weaken what production sends (docs/SECURITY.md §2).
 */
export interface CookiePolicy {
  readonly sessionCookieName: string;
  readonly csrfCookieName: string;
  readonly secure: boolean;
  readonly sameSite: 'lax' | 'strict';
  readonly path: '/';
  /** `__Host-` forbids a Domain attribute, so one is never set. */
  readonly domain: undefined;
  readonly httpOnly: true;
}

export const PRODUCTION_SESSION_COOKIE_NAME = '__Host-organic-os-session';
export const PRODUCTION_CSRF_COOKIE_NAME = '__Host-organic-os-csrf';
export const DEVELOPMENT_SESSION_COOKIE_NAME = 'organic-os-dev-session';
export const DEVELOPMENT_CSRF_COOKIE_NAME = 'organic-os-dev-csrf';

export interface AuthConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly sessionSecret: string;
  readonly absoluteLifetimeMs: number;
  readonly idleTimeoutMs: number;
  readonly touchIntervalMs: number;
  readonly cleanupGraceMs: number;
  readonly cookies: CookiePolicy;
  readonly loginRateLimit: {
    readonly ipMax: number;
    readonly accountMax: number;
    readonly windowMs: number;
  };
  readonly passwordHash: PasswordHashParameters;
}

function resolveCookiePolicy(env: AuthEnv): CookiePolicy {
  const isProduction = env.NODE_ENV === 'production';
  // Outside production the default is insecure cookies over plain HTTP; a developer
  // running HTTPS locally can opt back in with AUTH_COOKIE_SECURE=true.
  const secure = env.AUTH_COOKIE_SECURE ?? isProduction;

  return {
    sessionCookieName: secure ? PRODUCTION_SESSION_COOKIE_NAME : DEVELOPMENT_SESSION_COOKIE_NAME,
    csrfCookieName: secure ? PRODUCTION_CSRF_COOKIE_NAME : DEVELOPMENT_CSRF_COOKIE_NAME,
    secure,
    sameSite: env.AUTH_COOKIE_SAME_SITE,
    path: '/',
    domain: undefined,
    httpOnly: true,
  };
}

/**
 * Builds the authentication configuration, failing closed.
 *
 * @throws {AuthConfigError} when the environment is missing or would produce an
 * insecure production configuration.
 */
export function createAuthConfig(source: Readonly<Record<string, string | undefined>>): AuthConfig {
  const parsed = authEnvSchema.safeParse(source);

  if (!parsed.success) {
    // Names and failure codes only — every one of these variables may hold a secret.
    throw new AuthConfigError(
      parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join('.') || '(root)'} (${issue.code})`,
      ),
    );
  }

  const env = parsed.data;
  const cookies = resolveCookiePolicy(env);
  const issues: string[] = [];

  if (env.NODE_ENV === 'production' && !cookies.secure) {
    issues.push('AUTH_COOKIE_SECURE must not be false in production');
  }

  if (env.AUTH_SESSION_IDLE_TIMEOUT_MS > env.AUTH_SESSION_ABSOLUTE_LIFETIME_MS) {
    issues.push('AUTH_SESSION_IDLE_TIMEOUT_MS must not exceed AUTH_SESSION_ABSOLUTE_LIFETIME_MS');
  }

  if (issues.length > 0) {
    throw new AuthConfigError(issues);
  }

  return {
    nodeEnv: env.NODE_ENV,
    sessionSecret: env.AUTH_SESSION_SECRET,
    absoluteLifetimeMs: env.AUTH_SESSION_ABSOLUTE_LIFETIME_MS,
    idleTimeoutMs: env.AUTH_SESSION_IDLE_TIMEOUT_MS,
    touchIntervalMs: env.AUTH_SESSION_TOUCH_INTERVAL_MS,
    cleanupGraceMs: env.AUTH_SESSION_CLEANUP_GRACE_MS,
    cookies,
    loginRateLimit: {
      ipMax: env.AUTH_LOGIN_RATE_LIMIT_IP_MAX,
      accountMax: env.AUTH_LOGIN_RATE_LIMIT_ACCOUNT_MAX,
      windowMs: env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS,
    },
    passwordHash: {
      memoryCost: env.AUTH_ARGON2_MEMORY_COST_KIB ?? DEFAULT_PASSWORD_HASH_PARAMETERS.memoryCost,
      timeCost: env.AUTH_ARGON2_TIME_COST ?? DEFAULT_PASSWORD_HASH_PARAMETERS.timeCost,
      parallelism: env.AUTH_ARGON2_PARALLELISM ?? DEFAULT_PASSWORD_HASH_PARAMETERS.parallelism,
    },
  };
}
