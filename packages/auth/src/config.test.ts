import { describe, expect, it } from 'vitest';

import {
  createAuthConfig,
  DEVELOPMENT_CSRF_COOKIE_NAME,
  DEVELOPMENT_SESSION_COOKIE_NAME,
  PRODUCTION_CSRF_COOKIE_NAME,
  PRODUCTION_SESSION_COOKIE_NAME,
} from './config.js';
import { AuthConfigError } from './errors.js';

const SECRET = 'x'.repeat(64);

function env(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return { AUTH_SESSION_SECRET: SECRET, ...overrides };
}

describe('authentication configuration', () => {
  it('requires a session secret of usable length', () => {
    expect(() => createAuthConfig({})).toThrow(AuthConfigError);
    expect(() => createAuthConfig({ AUTH_SESSION_SECRET: 'too-short' })).toThrow(AuthConfigError);
  });

  it('reports variable names and codes only, never values', () => {
    try {
      createAuthConfig({ AUTH_SESSION_SECRET: 'super-secret-but-too-short' });
      expect.unreachable('expected configuration to be rejected');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AuthConfigError);
      expect((error as AuthConfigError).message).toContain('AUTH_SESSION_SECRET');
      expect((error as AuthConfigError).message).not.toContain('super-secret');
    }
  });

  it('applies documented lifetime defaults', () => {
    const config = createAuthConfig(env());

    expect(config.absoluteLifetimeMs).toBe(12 * 60 * 60 * 1_000);
    expect(config.idleTimeoutMs).toBe(2 * 60 * 60 * 1_000);
    expect(config.touchIntervalMs).toBe(60_000);
    expect(config.cleanupGraceMs).toBe(7 * 24 * 60 * 60 * 1_000);
  });

  it('lets every lifetime be configured', () => {
    const config = createAuthConfig(
      env({
        AUTH_SESSION_ABSOLUTE_LIFETIME_MS: String(60 * 60 * 1_000),
        AUTH_SESSION_IDLE_TIMEOUT_MS: String(15 * 60 * 1_000),
        AUTH_SESSION_TOUCH_INTERVAL_MS: '0',
        AUTH_SESSION_CLEANUP_GRACE_MS: String(24 * 60 * 60 * 1_000),
      }),
    );

    expect(config.absoluteLifetimeMs).toBe(60 * 60 * 1_000);
    expect(config.idleTimeoutMs).toBe(15 * 60 * 1_000);
    expect(config.touchIntervalMs).toBe(0);
  });

  it('rejects an idle window longer than the absolute lifetime', () => {
    expect(() =>
      createAuthConfig(
        env({
          AUTH_SESSION_ABSOLUTE_LIFETIME_MS: String(60 * 60 * 1_000),
          AUTH_SESSION_IDLE_TIMEOUT_MS: String(2 * 60 * 60 * 1_000),
        }),
      ),
    ).toThrow(AuthConfigError);
  });
});

describe('cookie policy — production', () => {
  const config = createAuthConfig(env({ NODE_ENV: 'production' }));

  it('uses __Host-prefixed names', () => {
    expect(config.cookies.sessionCookieName).toBe(PRODUCTION_SESSION_COOKIE_NAME);
    expect(config.cookies.csrfCookieName).toBe(PRODUCTION_CSRF_COOKIE_NAME);
    expect(config.cookies.sessionCookieName.startsWith('__Host-')).toBe(true);
  });

  it('sets every attribute the prefix and the threat model require', () => {
    expect(config.cookies).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      domain: undefined,
    });
  });

  it('fails closed when asked to serve insecure cookies', () => {
    // The whole point of the dev/prod split: nothing about making localhost work can
    // reach production settings.
    expect(() =>
      createAuthConfig(env({ NODE_ENV: 'production', AUTH_COOKIE_SECURE: 'false' })),
    ).toThrow(AuthConfigError);
  });

  it('allows SameSite=Strict where the deployment permits it', () => {
    const strict = createAuthConfig(
      env({ NODE_ENV: 'production', AUTH_COOKIE_SAME_SITE: 'strict' }),
    );
    expect(strict.cookies.sameSite).toBe('strict');
  });
});

describe('cookie policy — development', () => {
  const config = createAuthConfig(env({ NODE_ENV: 'development' }));

  it('uses separate, differently named cookies', () => {
    expect(config.cookies.sessionCookieName).toBe(DEVELOPMENT_SESSION_COOKIE_NAME);
    expect(config.cookies.csrfCookieName).toBe(DEVELOPMENT_CSRF_COOKIE_NAME);
    expect(config.cookies.sessionCookieName.startsWith('__Host-')).toBe(false);
  });

  it('drops only Secure — HttpOnly and Path are unchanged', () => {
    expect(config.cookies.secure).toBe(false);
    expect(config.cookies.httpOnly).toBe(true);
    expect(config.cookies.path).toBe('/');
  });

  it('opts back into the production profile when local HTTPS is available', () => {
    const secure = createAuthConfig(env({ NODE_ENV: 'development', AUTH_COOKIE_SECURE: 'true' }));

    expect(secure.cookies.secure).toBe(true);
    expect(secure.cookies.sessionCookieName).toBe(PRODUCTION_SESSION_COOKIE_NAME);
  });
});

describe('rate limit and hashing configuration', () => {
  it('has defaults suitable for credential abuse', () => {
    const config = createAuthConfig(env());

    expect(config.loginRateLimit).toEqual({
      ipMax: 20,
      accountMax: 10,
      windowMs: 15 * 60 * 1_000,
    });
  });

  it('carries the production Argon2id parameters unless overridden', () => {
    expect(createAuthConfig(env()).passwordHash).toEqual({
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    expect(
      createAuthConfig(env({ AUTH_ARGON2_MEMORY_COST_KIB: '65536', AUTH_ARGON2_TIME_COST: '3' }))
        .passwordHash,
    ).toEqual({ memoryCost: 65_536, timeCost: 3, parallelism: 1 });
  });

  it('refuses an Argon2 memory cost below a defensible floor', () => {
    expect(() => createAuthConfig(env({ AUTH_ARGON2_MEMORY_COST_KIB: '1024' }))).toThrow(
      AuthConfigError,
    );
  });
});
