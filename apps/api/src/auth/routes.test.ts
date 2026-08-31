import { createAuthConfig, type AuthConfig } from '@organic-os/auth';
import { InMemoryAuthStore } from '@organic-os/auth/testing';
import {
  csrfTokenResponseSchema,
  currentUserSchema,
  loginResponseSchema,
  problemDetailsSchema,
} from '@organic-os/contracts';
import { createLogger, type LogDestination } from '@organic-os/observability';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { CookieJar, TEST_AUTH_ENV, testPasswordHasher } from '../testing/auth-helpers.js';
import { buildAuthDependencies } from './build.js';
import type { AuthDependencies } from './context.js';

const PASSWORD = 'correct horse battery staple';
const EMAIL = 'owner@example.test';

let app: FastifyInstance;
let store: InMemoryAuthStore;
let deps: AuthDependencies;
let config: AuthConfig;
let jar: CookieJar;
let logLines: string[];

const destination: LogDestination = {
  write(chunk: string): void {
    logLines.push(chunk);
  },
};

/**
 * Fetches a CSRF token the way a browser would — carrying whatever cookies the jar
 * already holds, so the token binds to the caller's *current* session rather than to
 * `anonymous`.
 */
async function bootstrapCsrf(): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: '/auth/csrf',
    headers: { cookie: jar.header() },
  });

  jar.absorb(response);
  return csrfTokenResponseSchema.parse(response.json()).csrfToken;
}

async function login(
  body: Record<string, unknown> = { email: EMAIL, password: PASSWORD },
): Promise<LightMyRequestResponse> {
  await bootstrapCsrf();

  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { ...jar.headersFor(config), 'content-type': 'application/json' },
    payload: body,
  });

  jar.absorb(response);
  return response;
}

beforeEach(async () => {
  logLines = [];
  jar = new CookieJar();
  config = createAuthConfig({ ...TEST_AUTH_ENV, AUTH_LOGIN_RATE_LIMIT_ACCOUNT_MAX: '3' });
  store = new InMemoryAuthStore();

  store.addUser({
    email: EMAIL,
    name: 'Owner',
    passwordHash: await testPasswordHasher.hash(PASSWORD),
    isPlatformAdmin: false,
  });

  deps = buildAuthDependencies({ store, config });

  app = buildApp({
    logger: createLogger({ name: 'api-test', level: 'trace' }, destination),
    serviceVersion: '0.0.0-test',
    auth: deps,
  });

  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('GET /auth/csrf', () => {
  it('issues a token and the cookie carrying it', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/csrf' });
    jar.absorb(response);

    const body = csrfTokenResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(body.headerName).toBe('x-csrf-token');
    expect(jar.get(config.cookies.csrfCookieName)).toBe(body.csrfToken);
  });

  it('is not itself CSRF-checked, because it is a safe method', async () => {
    expect((await app.inject({ method: 'GET', url: '/auth/csrf' })).statusCode).toBe(200);
  });

  it('is not cacheable', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/csrf' });
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /auth/login', () => {
  it('authenticates a valid credential and sets a session cookie', async () => {
    const response = await login();

    expect(response.statusCode).toBe(200);

    const body = loginResponseSchema.parse(response.json());

    expect(body.user.email).toBe(EMAIL);
    expect(body.user.name).toBe('Owner');
    expect(jar.get(config.cookies.sessionCookieName)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('returns identity only — no organization, role or platform flag', async () => {
    const body = loginResponseSchema.parse((await login()).json());

    expect(Object.keys(body.user).sort()).toEqual(['email', 'id', 'locale', 'name']);
    expect(JSON.stringify(body)).not.toContain('isPlatformAdmin');
    expect(JSON.stringify(body)).not.toContain('organization');
  });

  it('sets a session cookie with the configured attributes', async () => {
    const response = await login();
    const header = response.headers['set-cookie'];
    const cookies = Array.isArray(header) ? header : [String(header)];
    const session = cookies.find((value) => value.startsWith(config.cookies.sessionCookieName));

    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Lax');
    expect(session).toContain('Path=/');
    expect(session).not.toContain('Domain');
  });

  it('rotates the CSRF token onto the new session', async () => {
    const before = await bootstrapCsrf();
    const response = await login();
    const after = loginResponseSchema.parse(response.json()).csrfToken;

    expect(after).not.toBe(before);
    expect(jar.get(config.cookies.csrfCookieName)).toBe(after);
  });

  it('answers a wrong password and an unknown address identically', async () => {
    const wrongPassword = await login({ email: EMAIL, password: 'wrong' });
    jar.clear();
    const unknownUser = await login({ email: 'nobody@example.test', password: PASSWORD });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);

    const strip = (payload: unknown): unknown => {
      const problem = problemDetailsSchema.parse(payload);
      return { ...problem, requestId: undefined };
    };

    expect(strip(wrongPassword.json())).toEqual(strip(unknownUser.json()));
  });

  it('never reveals internals in the failure body', async () => {
    const problem = problemDetailsSchema.parse(
      (await login({ email: EMAIL, password: 'x' })).json(),
    );

    expect(problem.status).toBe(401);
    expect(JSON.stringify(problem)).not.toContain('argon2');
    expect(JSON.stringify(problem)).not.toContain('password_hash');
    expect(problem.detail).toBe('Email or password is incorrect.');
  });

  it('sets no session cookie on failure', async () => {
    const response = await login({ email: EMAIL, password: 'wrong' });

    expect(jar.get(config.cookies.sessionCookieName)).toBeUndefined();
    expect(String(response.headers['set-cookie'] ?? '')).not.toContain(
      `${config.cookies.sessionCookieName}=a`,
    );
  });

  it('rejects a malformed body without echoing it', async () => {
    const response = await login({ email: 'x', password: '' });
    const problem = problemDetailsSchema.parse(response.json());

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(problem)).not.toContain('password');
  });

  it('throttles repeated failures and says nothing about the account', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await login({ email: EMAIL, password: 'wrong' })).statusCode).toBe(401);
    }

    const throttled = await login({ email: EMAIL, password: 'wrong' });

    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers['retry-after']).toBeDefined();

    // The correct password is refused too while the budget is spent.
    expect((await login()).statusCode).toBe(429);
  });

  it('throttles an unknown address the same way', async () => {
    const unknown = { email: 'nobody@example.test', password: 'wrong' };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await login(unknown)).statusCode).toBe(401);
    }

    expect((await login(unknown)).statusCode).toBe(429);
  });

  it('invalidates a session the caller already held', async () => {
    await login();
    const firstToken = jar.get(config.cookies.sessionCookieName);

    await login();
    const secondToken = jar.get(config.cookies.sessionCookieName);

    expect(secondToken).not.toBe(firstToken);
    expect((await deps.sessions.resolveSession(firstToken)).ok).toBe(false);
    expect((await deps.sessions.resolveSession(secondToken)).ok).toBe(true);
  });
});

describe('GET /auth/me', () => {
  it('refuses an unauthenticated caller', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/me' });

    expect(response.statusCode).toBe(401);
    expect(problemDetailsSchema.parse(response.json()).title).toBe('Authentication Required');
  });

  it('returns the identity of an authenticated caller', async () => {
    await login();

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: jar.header() },
    });

    expect(response.statusCode).toBe(200);
    expect(currentUserSchema.parse(response.json()).email).toBe(EMAIL);
  });

  it('exposes no authorization data whatsoever', async () => {
    await login();

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: jar.header() },
    });

    const body = response.json<Record<string, unknown>>();

    expect(Object.keys(body).sort()).toEqual(['email', 'id', 'locale', 'name']);
    for (const forbidden of [
      'isPlatformAdmin',
      'organizationId',
      'organizations',
      'memberships',
      'role',
      'roles',
      'permissions',
      'passwordHash',
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it('is a safe method and needs no CSRF token', async () => {
    await login();

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: jar.header() },
    });

    expect(response.statusCode).toBe(200);
  });

  it('refuses a revoked session', async () => {
    await login();
    await deps.sessions.revokeByToken(jar.get(config.cookies.sessionCookieName));

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: jar.header() },
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses a forged session cookie', async () => {
    jar.set(config.cookies.sessionCookieName, 'a'.repeat(43));

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: jar.header() },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  async function logout(): Promise<LightMyRequestResponse> {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: jar.headersFor(config),
    });

    jar.absorb(response);
    return response;
  }

  it('revokes the session server-side', async () => {
    await login();
    const token = jar.get(config.cookies.sessionCookieName);

    expect((await logout()).statusCode).toBe(204);
    expect((await deps.sessions.resolveSession(token)).ok).toBe(false);
  });

  it('clears the session cookie', async () => {
    await login();
    const response = await logout();
    const header = String(response.headers['set-cookie'] ?? '');

    expect(header).toContain(`${config.cookies.sessionCookieName}=;`);
    expect(header).toContain('Max-Age=0');
    expect(jar.get(config.cookies.sessionCookieName)).toBeUndefined();
  });

  it('is idempotent — logging out twice still succeeds', async () => {
    await login();

    expect((await logout()).statusCode).toBe(204);
    // The CSRF cookie was rebound to anonymous by the first logout, so the jar now
    // carries exactly what a browser would.
    expect((await logout()).statusCode).toBe(204);
  });

  it('succeeds for a caller who never had a session', async () => {
    await bootstrapCsrf();
    expect((await logout()).statusCode).toBe(204);
  });
});

describe('CSRF enforcement', () => {
  it('rejects a state-changing request with no token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    });

    expect(response.statusCode).toBe(403);
    expect(problemDetailsSchema.parse(response.json()).title).toBe('CSRF Token Invalid');
  });

  it('rejects a cookie token with no matching header', async () => {
    await bootstrapCsrf();

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { cookie: jar.header() },
      payload: { email: EMAIL, password: PASSWORD },
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects a header token with no matching cookie', async () => {
    const token = await bootstrapCsrf();

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-csrf-token': token },
      payload: { email: EMAIL, password: PASSWORD },
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects a mismatched pair even when both halves are valid tokens', async () => {
    const first = await bootstrapCsrf();
    await bootstrapCsrf();

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { cookie: jar.header(), 'x-csrf-token': first },
      payload: { email: EMAIL, password: PASSWORD },
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects a token bound to a different session', async () => {
    await login();

    // Two logins in the same browser: the first session's CSRF token must not be
    // accepted once the session has been replaced.
    const staleToken = jar.get(config.cookies.csrfCookieName) ?? '';
    await login();
    const currentCookie = jar.header();

    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        cookie: currentCookie.replace(
          `${config.cookies.csrfCookieName}=${encodeURIComponent(jar.get(config.cookies.csrfCookieName) ?? '')}`,
          `${config.cookies.csrfCookieName}=${encodeURIComponent(staleToken)}`,
        ),
        'x-csrf-token': staleToken,
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects an anonymous token once the caller is authenticated', async () => {
    // A token minted before login is bound to `anonymous`; the live session's binding
    // is its session id, so the stale token no longer verifies.
    const anonymousApp = buildApp({
      logger: createLogger({ name: 'anon', level: 'silent' }),
      serviceVersion: '0.0.0-test',
      auth: deps,
    });
    await anonymousApp.ready();

    const anonymousJar = new CookieJar();
    const bootstrap = await anonymousApp.inject({ method: 'GET', url: '/auth/csrf' });
    anonymousJar.absorb(bootstrap);
    const anonymousToken = anonymousJar.get(config.cookies.csrfCookieName) ?? '';

    await login();

    const response = await anonymousApp.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        cookie: `${config.cookies.sessionCookieName}=${encodeURIComponent(jar.get(config.cookies.sessionCookieName) ?? '')}; ${config.cookies.csrfCookieName}=${encodeURIComponent(anonymousToken)}`,
        'x-csrf-token': anonymousToken,
      },
    });

    expect(response.statusCode).toBe(403);
    await anonymousApp.close();
  });

  it('leaves safe methods alone', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auth/me' })).statusCode).toBe(401);
  });
});

describe('authentication logging', () => {
  function loggedText(): string {
    return logLines.join('\n');
  }

  it('never writes a password', async () => {
    await login({ email: EMAIL, password: PASSWORD });
    await login({ email: EMAIL, password: 'a-very-distinctive-wrong-password' });

    expect(loggedText()).not.toContain(PASSWORD);
    expect(loggedText()).not.toContain('a-very-distinctive-wrong-password');
  });

  it('never writes a raw session token', async () => {
    await login();
    const token = jar.get(config.cookies.sessionCookieName) ?? '';

    await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: jar.header() } });

    expect(token).not.toBe('');
    expect(loggedText()).not.toContain(token);
  });

  it('never writes a CSRF token', async () => {
    const token = await bootstrapCsrf();

    await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { cookie: jar.header(), 'x-csrf-token': 'mismatched' },
      payload: { email: EMAIL, password: PASSWORD },
    });

    expect(loggedText()).not.toContain(token);
  });

  it('never writes a Cookie header', async () => {
    await login();
    await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: jar.header() } });

    expect(loggedText()).not.toContain('__Host-');
    expect(loggedText()).not.toContain(jar.header());
  });

  it('never writes the session secret', async () => {
    await login();
    expect(loggedText()).not.toContain(config.sessionSecret);
  });

  it('does record what an investigation needs', async () => {
    await login();

    const records = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const success = records.find((record) => record['msg'] === 'login succeeded');

    expect(success).toBeDefined();
    expect(success?.['userId']).toBeTypeOf('string');
    expect(success?.['requestId']).toBeTypeOf('string');

    await login({ email: EMAIL, password: 'wrong' });

    const failures = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record['msg'] === 'login attempt failed');

    expect(failures.at(-1)?.['reason']).toBe('bad_password');
  });
});
