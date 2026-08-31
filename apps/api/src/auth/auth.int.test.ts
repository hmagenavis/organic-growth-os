import { createAuthConfig, type AuthConfig } from '@organic-os/auth';
import {
  createAuthStore,
  provisionUser,
  withTenantTransaction,
  type TenantContext,
} from '@organic-os/database';
import {
  createTestDatabase,
  seedTwoTenants,
  type SeededTenants,
  type TestDatabase,
} from '@organic-os/database/testing';
import {
  currentUserSchema,
  loginResponseSchema,
  problemDetailsSchema,
} from '@organic-os/contracts';
import { createLogger, type LogDestination } from '@organic-os/observability';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { buildApp } from '../app.js';
import { CookieJar, TEST_AUTH_ENV, testPasswordHasher } from '../testing/auth-helpers.js';
import { buildAuthDependencies } from './build.js';
import type { AuthDependencies } from './context.js';

/**
 * The API's authentication endpoints against real PostgreSQL.
 *
 * The unit suite proves the HTTP behaviour; this suite proves that behaviour survives
 * the real persistence layer — Row Level Security, role grants, and the point-lookup
 * policy on `users` — and that a session established here confers no tenant authority.
 */

const PASSWORD = 'correct horse battery staple';
const EMAIL = 'authenticated@example.test';

let database: TestDatabase;
let tenants: SeededTenants;
let app: FastifyInstance;
let deps: AuthDependencies;
let config: AuthConfig;
let jar: CookieJar;
let logLines: string[];
let userId: string;

const destination: LogDestination = {
  write(chunk: string): void {
    logLines.push(chunk);
  },
};

beforeAll(async () => {
  database = await createTestDatabase(inject('postgresAdminUri'), 'organic_os_api_auth_test');
  tenants = await seedTwoTenants(database.runtime, database.provisioner);

  // The privileged provisioning path is the only way a credential can be written.
  // The API process never opens this connection.
  const user = await provisionUser(database.provisioner.db, {
    email: EMAIL,
    name: 'Authenticated User',
    passwordHash: await testPasswordHasher.hash(PASSWORD),
  });

  userId = user.id;

  config = createAuthConfig({ ...TEST_AUTH_ENV, AUTH_LOGIN_RATE_LIMIT_ACCOUNT_MAX: '4' });

  deps = buildAuthDependencies({ store: createAuthStore(database.runtime.db), config });

  app = buildApp({
    logger: createLogger({ name: 'api-int', level: 'trace' }, destination),
    serviceVersion: '0.0.0-test',
    auth: deps,
  });

  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await database?.close();
});

beforeEach(() => {
  jar = new CookieJar();
  logLines = [];
});

async function bootstrapCsrf(): Promise<void> {
  jar.absorb(
    await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie: jar.header() } }),
  );
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

async function sessionRows(): Promise<
  { id: string; user_id: string; token_hash: Buffer; revoked_at: Date | null }[]
> {
  const result = await database.runtime.pool.query<{
    id: string;
    user_id: string;
    token_hash: Buffer;
    revoked_at: Date | null;
  }>('SELECT id, user_id, token_hash, revoked_at FROM sessions ORDER BY created_at');

  return result.rows;
}

describe('end-to-end login against PostgreSQL', () => {
  it('authenticates and persists a server-side session', async () => {
    const response = await login();

    expect(response.statusCode).toBe(200);
    expect(loginResponseSchema.parse(response.json()).user.id).toBe(userId);

    const live = (await sessionRows()).filter((row) => row.revoked_at === null);
    expect(live.some((row) => row.user_id === userId)).toBe(true);
  });

  it('stores only the hash of the cookie token', async () => {
    await login();

    const token = jar.get(config.cookies.sessionCookieName) ?? '';
    const rows = await sessionRows();

    expect(token).not.toBe('');
    for (const row of rows) {
      expect(row.token_hash.toString('base64url')).not.toBe(token);
      expect(JSON.stringify(row)).not.toContain(token);
    }
  });

  it('records the login on the user row', async () => {
    await login();

    const result = await database.provisioner.pool.query<{ last_login_at: Date | null }>(
      'SELECT last_login_at FROM users WHERE id = $1',
      [userId],
    );

    expect(result.rows[0]?.last_login_at).not.toBeNull();
  });

  it('answers a wrong password and an unknown address identically', async () => {
    const wrong = await login({ email: EMAIL, password: 'wrong' });
    jar.clear();
    const unknown = await login({ email: 'nobody@example.test', password: PASSWORD });

    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect({ ...wrong.json<Record<string, unknown>>(), requestId: null }).toEqual({
      ...unknown.json<Record<string, unknown>>(),
      requestId: null,
    });
  });

  it('gives a seeded tenant user with no credential the same generic failure', async () => {
    // `seedTwoTenants` creates users without a password. "No credential set" must be
    // indistinguishable from "wrong password" and "no such address".
    const response = await login({ email: 'owner-a@example.test', password: PASSWORD });

    expect(response.statusCode).toBe(401);
    expect(problemDetailsSchema.parse(response.json()).detail).toBe(
      'Email or password is incorrect.',
    );
  });
});

describe('session lifecycle against PostgreSQL', () => {
  it('serves /auth/me from the persisted session', async () => {
    await login();

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: jar.header() },
    });

    expect(response.statusCode).toBe(200);
    expect(currentUserSchema.parse(response.json())).toMatchObject({ id: userId, email: EMAIL });
  });

  it('revokes the row on logout and clears the cookie', async () => {
    await login();
    const token = jar.get(config.cookies.sessionCookieName) ?? '';

    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: jar.headersFor(config),
    });
    jar.absorb(response);

    expect(response.statusCode).toBe(204);
    expect(jar.get(config.cookies.sessionCookieName)).toBeUndefined();

    const revoked = (await sessionRows()).find(
      (row) => row.token_hash.toString('hex') !== '' && row.revoked_at !== null,
    );
    expect(revoked).toBeDefined();

    // The token is dead even if the client keeps sending it.
    const after = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `${config.cookies.sessionCookieName}=${encodeURIComponent(token)}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('rotates on re-authentication, leaving the old row revoked', async () => {
    await login();
    const first = jar.get(config.cookies.sessionCookieName) ?? '';

    await login();
    const second = jar.get(config.cookies.sessionCookieName) ?? '';

    expect(second).not.toBe(first);
    expect((await deps.sessions.resolveSession(first)).ok).toBe(false);
    expect((await deps.sessions.resolveSession(second)).ok).toBe(true);
  });

  it('rejects a session revoked out of band', async () => {
    await login();
    await deps.sessions.revokeAllForUser(userId);

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: jar.header() },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a session whose row expired', async () => {
    await login();

    await database.runtime.pool.query(
      "UPDATE sessions SET expires_at = now() - interval '1 second' WHERE revoked_at IS NULL",
    );

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: jar.header() },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('CSRF against the real stack', () => {
  it('rejects a state-changing request with no token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    });

    expect(response.statusCode).toBe(403);
  });

  it('does not block reads', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auth/csrf' })).statusCode).toBe(200);
  });
});

describe('authentication confers no tenant authorization', () => {
  it('an authenticated identity carries no organization', async () => {
    await login();

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: jar.header() },
    });

    const body = response.json<Record<string, unknown>>();

    expect(Object.keys(body).sort()).toEqual(['email', 'id', 'locale', 'name']);
    expect(JSON.stringify(body)).not.toContain('organization');
  });

  it('sets no tenant context on the pooled connection the request used', async () => {
    await login();
    await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: jar.header() } });

    // The API's own pool: after serving an authenticated request, no connection in it
    // carries an organization identity.
    const result = await database.runtime.pool.query<{ id: string | null }>(
      'SELECT app.current_org_id() AS id',
    );

    expect(result.rows[0]?.id).toBeNull();
  });

  it('a session for an organization member still reaches no organization rows', async () => {
    // Give the seeded agency_admin of organization A a real credential and log in as
    // them. They are a genuine member with the highest organization role.
    const memberEmail = 'owner-a@example.test';

    await database.provisioner.pool.query('UPDATE users SET password_hash = $1 WHERE email = $2', [
      await testPasswordHasher.hash(PASSWORD),
      memberEmail,
    ]);

    const response = await login({ email: memberEmail, password: PASSWORD });
    expect(response.statusCode).toBe(200);

    const resolution = await deps.sessions.resolveSession(
      jar.get(config.cookies.sessionCookieName),
    );
    expect(resolution.ok).toBe(true);

    // Authentication succeeded. Tenant data is still unreachable, because nothing in
    // the authentication path establishes app.current_org_id. Phase 0.4's
    // authorization step is what would.
    for (const table of ['organizations', 'clients', 'sites', 'memberships', 'site_settings']) {
      const rows = await database.runtime.pool.query(`SELECT * FROM ${table}`);
      expect(rows.rows).toHaveLength(0);
    }
  });

  it('an authenticated identity cannot be turned into a tenant context by the API', async () => {
    await login();

    const identity = (await deps.sessions.resolveSession(jar.get(config.cookies.sessionCookieName)))
      .ok
      ? 'authenticated'
      : 'anonymous';

    expect(identity).toBe('authenticated');

    // There is no field on the authenticated identity from which an organization
    // could be read: the type carries a user and a session and nothing else. The
    // only way to reach tenant data remains an explicitly constructed context.
    const explicit: TenantContext = tenants.a.tenant;
    const clients = await withTenantTransaction(database.runtime.db, explicit, (repos) =>
      repos.clients.list(),
    );

    expect(clients).toHaveLength(1);
    expect(clients[0]?.id).toBe(tenants.a.clientId);

    // …and constructing it required organization A's id, which authentication never
    // supplied. A different organization's context yields a different, isolated view.
    const otherClients = await withTenantTransaction(
      database.runtime.db,
      tenants.b.tenant,
      (repos) => repos.clients.list(),
    );

    expect(otherClients[0]?.id).toBe(tenants.b.clientId);
  });
});

describe('logging over the real stack', () => {
  it('leaks no credential, token or cookie', async () => {
    await login();
    const sessionToken = jar.get(config.cookies.sessionCookieName) ?? '';
    const csrfToken = jar.get(config.cookies.csrfCookieName) ?? '';

    await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: jar.header() } });
    await login({ email: EMAIL, password: 'a-distinctive-wrong-password' });

    const text = logLines.join('\n');

    expect(text).not.toBe('');
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('a-distinctive-wrong-password');
    expect(text).not.toContain(sessionToken);
    expect(text).not.toContain(csrfToken);
    expect(text).not.toContain(config.sessionSecret);
    expect(text).not.toContain('password_hash');
    expect(text).not.toContain('$argon2id$');
  });
});
