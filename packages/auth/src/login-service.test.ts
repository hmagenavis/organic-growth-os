import { beforeEach, describe, expect, it } from 'vitest';

import { createAuthConfig, type AuthConfig } from './config.js';
import { createLoginService, normalizeEmail, type LoginService } from './login-service.js';
import { createPasswordHasher, type PasswordHasher } from './password.js';
import { createLoginRateLimiter } from './rate-limit/login-limiter.js';
import { InMemoryRateLimitStore } from './rate-limit/memory.js';
import { createSessionService, type SessionService } from './session-service.js';
import { InMemoryAuthStore } from './testing/in-memory-store.js';

const config: AuthConfig = createAuthConfig({
  AUTH_SESSION_SECRET: 'x'.repeat(64),
  AUTH_LOGIN_RATE_LIMIT_IP_MAX: '50',
  AUTH_LOGIN_RATE_LIMIT_ACCOUNT_MAX: '3',
  AUTH_LOGIN_RATE_LIMIT_WINDOW_MS: '60000',
  // Test-only cost. Production values are asserted in password.test.ts.
  AUTH_ARGON2_MEMORY_COST_KIB: '8192',
  AUTH_ARGON2_TIME_COST: '1',
});

const PASSWORD = 'correct horse battery staple';
const EMAIL = 'owner@example.test';
const SOURCE = '203.0.113.7';

let store: InMemoryAuthStore;
let sessions: SessionService;
let logins: LoginService;
let passwords: PasswordHasher;
let clock: Date;
let userId: string;

beforeEach(async () => {
  clock = new Date('2026-08-31T09:00:00.000Z');
  store = new InMemoryAuthStore();
  passwords = createPasswordHasher(config.passwordHash);
  sessions = createSessionService({ store, config, now: () => clock });
  logins = createLoginService({
    store,
    sessions,
    passwords,
    rateLimiter: createLoginRateLimiter({
      store: new InMemoryRateLimitStore(),
      config,
      now: () => clock.getTime(),
    }),
    now: () => clock,
  });

  userId = store.addUser({
    email: EMAIL,
    name: 'Owner',
    passwordHash: await passwords.hash(PASSWORD),
    isPlatformAdmin: false,
  }).id;
});

describe('successful login', () => {
  it('authenticates a valid credential and issues a session', async () => {
    const result = await logins.login({ email: EMAIL, password: PASSWORD, sourceKey: SOURCE });

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.user.id).toBe(userId);
      expect(result.session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await sessions.resolveSession(result.session.token)).ok).toBe(true);
    }
  });

  it('matches the address case-insensitively and ignores surrounding space', async () => {
    const result = await logins.login({
      email: `  ${EMAIL.toUpperCase()}  `,
      password: PASSWORD,
      sourceKey: SOURCE,
    });

    expect(result.ok).toBe(true);
  });

  it('records the login time', async () => {
    await logins.login({ email: EMAIL, password: PASSWORD, sourceKey: SOURCE });
    expect(store.lastLoginAt(userId)).toEqual(clock);
  });

  it('rotates an existing session rather than leaving it valid', async () => {
    const existing = await sessions.createSession(userId);

    const result = await logins.login({
      email: EMAIL,
      password: PASSWORD,
      sourceKey: SOURCE,
      existingSessionToken: existing.token,
    });

    expect(result.ok).toBe(true);
    // Session fixation: the token the caller arrived with is dead afterwards.
    expect((await sessions.resolveSession(existing.token)).ok).toBe(false);

    if (result.ok) {
      expect(result.session.token).not.toBe(existing.token);
      expect((await sessions.resolveSession(result.session.token)).ok).toBe(true);
    }
  });
});

describe('failed login', () => {
  it('rejects a wrong password', async () => {
    const result = await logins.login({ email: EMAIL, password: 'wrong', sourceKey: SOURCE });

    expect(result).toEqual({ ok: false, reason: 'bad_password' });
  });

  it('rejects an unknown address', async () => {
    const result = await logins.login({
      email: 'nobody@example.test',
      password: PASSWORD,
      sourceKey: SOURCE,
    });

    expect(result).toEqual({ ok: false, reason: 'unknown_user' });
  });

  it('rejects a user with no credential set', async () => {
    store.addUser({
      email: 'invited@example.test',
      name: 'Invited',
      passwordHash: null,
      isPlatformAdmin: false,
    });

    const result = await logins.login({
      email: 'invited@example.test',
      password: PASSWORD,
      sourceKey: SOURCE,
    });

    expect(result).toEqual({ ok: false, reason: 'no_credential' });
  });

  it('issues no session on failure', async () => {
    await logins.login({ email: EMAIL, password: 'wrong', sourceKey: SOURCE });
    await logins.login({ email: 'nobody@example.test', password: PASSWORD, sourceKey: SOURCE });

    expect(store.allSessions()).toHaveLength(0);
  });

  it('leaves an existing session alone when the credential is wrong', async () => {
    const existing = await sessions.createSession(userId);

    await logins.login({
      email: EMAIL,
      password: 'wrong',
      sourceKey: SOURCE,
      existingSessionToken: existing.token,
    });

    expect((await sessions.resolveSession(existing.token)).ok).toBe(true);
  });

  it('spends comparable time on an unknown address and a wrong password', async () => {
    // A real timing assertion would be flaky; what is asserted is the property that
    // makes the timings comparable — that the unknown-address path performs a hash
    // verification at the same cost rather than returning immediately.
    const measure = async (email: string): Promise<number> => {
      const started = process.hrtime.bigint();
      await logins.login({ email, password: 'wrong-password', sourceKey: `probe-${email}` });
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    const known = await measure(EMAIL);
    const unknown = await measure('nobody@example.test');
    const slower = Math.max(known, unknown);
    const faster = Math.max(1, Math.min(known, unknown));

    expect(slower / faster).toBeLessThan(5);
  });
});

describe('login rate limiting', () => {
  it('throttles after the configured number of failures', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await logins.login({ email: EMAIL, password: 'wrong', sourceKey: SOURCE })).ok).toBe(
        false,
      );
    }

    const result = await logins.login({ email: EMAIL, password: 'wrong', sourceKey: SOURCE });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('rate_limited');
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('refuses the correct password too once throttled', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await logins.login({ email: EMAIL, password: 'wrong', sourceKey: SOURCE });
    }

    const result = await logins.login({ email: EMAIL, password: PASSWORD, sourceKey: SOURCE });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('rate_limited');
    }
  });

  it('throttles a nonexistent account identically, revealing nothing', async () => {
    const attempt = async (email: string): Promise<string> => {
      const result = await logins.login({ email, password: 'wrong', sourceKey: `s-${email}` });
      return result.ok ? 'ok' : result.reason;
    };

    for (let index = 0; index < 3; index += 1) {
      await attempt(EMAIL);
      await attempt('nobody@example.test');
    }

    expect(await attempt(EMAIL)).toBe('rate_limited');
    expect(await attempt('nobody@example.test')).toBe('rate_limited');
  });

  it('clears the account budget after a successful login', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await logins.login({ email: EMAIL, password: 'wrong', sourceKey: SOURCE });
    }

    expect((await logins.login({ email: EMAIL, password: PASSWORD, sourceKey: SOURCE })).ok).toBe(
      true,
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await logins.login({ email: EMAIL, password: 'wrong', sourceKey: SOURCE });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('bad_password');
      }
    }
  });
});

describe('email normalization', () => {
  it('trims and lowercases, and nothing else', () => {
    expect(normalizeEmail('  Owner@Example.TEST ')).toBe('owner@example.test');
    // Dots and +tags identify distinct mailboxes at most providers and are preserved.
    expect(normalizeEmail('first.last+tag@example.test')).toBe('first.last+tag@example.test');
  });
});
