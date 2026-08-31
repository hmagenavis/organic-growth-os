import { createAuthConfig, type AuthConfig } from '@organic-os/auth';
import {
  createAuthorizationService,
  createAuthStore,
  createMembershipStore,
  provisionMembership,
  provisionOrganization,
  provisionUser,
  withTenantTransaction,
  type TenantContext,
} from '@organic-os/database';
import { createTestDatabase, type TestDatabase } from '@organic-os/database/testing';
import {
  organizationListResponseSchema,
  organizationResponseSchema,
  problemDetailsSchema,
} from '@organic-os/contracts';
import { createLogger, type LogDestination } from '@organic-os/observability';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { buildApp } from '../app.js';
import { buildAuthDependencies } from '../auth/build.js';
import { CookieJar, TEST_AUTH_ENV, testPasswordHasher } from '../testing/auth-helpers.js';

/**
 * The whole pipeline over HTTP, against real PostgreSQL.
 *
 * Authenticate → choose an organization → prove membership → tenant transaction →
 * response. Every refusal in here is refused by the same code a deployment runs, with
 * Row Level Security switched on and the runtime role's real grants.
 */

const PASSWORD = 'correct horse battery staple';

let database: TestDatabase;
let app: FastifyInstance;
let config: AuthConfig;
let jar: CookieJar;
let logLines: string[];

interface Fixture {
  orgA: string;
  orgB: string;
  adminEmail: string;
  viewerEmail: string;
  outsiderEmail: string;
  foreignEmail: string;
  platformAdminEmail: string;
  viewerMembershipId: string;
  viewerUserId: string;
}

let fixture: Fixture;

const destination: LogDestination = {
  write(chunk: string): void {
    logLines.push(chunk);
  },
};

beforeAll(async () => {
  database = await createTestDatabase(inject('postgresAdminUri'), 'organic_os_api_authz_test');

  const provisioner = database.provisioner.db;
  const passwordHash = await testPasswordHasher.hash(PASSWORD);

  const organizationA = await provisionOrganization(provisioner, {
    name: 'Api Authz A',
    slug: 'api-authz-a',
  });
  const organizationB = await provisionOrganization(provisioner, {
    name: 'Api Authz B',
    slug: 'api-authz-b',
  });

  async function user(handle: string): Promise<{ id: string; email: string }> {
    const record = await provisionUser(provisioner, {
      email: `${handle}@example.test`,
      name: handle,
      passwordHash,
    });
    return { id: record.id, email: record.email };
  }

  const admin = await user('api-authz-admin');
  const viewer = await user('api-authz-viewer');
  const outsider = await user('api-authz-outsider');
  const foreign = await user('api-authz-foreign');

  const platformAdmin = await provisionUser(provisioner, {
    email: 'api-authz-platform@example.test',
    name: 'Platform Admin',
    passwordHash,
    isPlatformAdmin: true,
  });

  await provisionMembership(provisioner, {
    organizationId: organizationA.id,
    userId: admin.id,
    role: 'agency_admin',
    clientAccessMode: 'all_clients',
  });

  const viewerMembership = await provisionMembership(provisioner, {
    organizationId: organizationA.id,
    userId: viewer.id,
    role: 'client_viewer',
    clientAccessMode: 'scoped',
  });

  await provisionMembership(provisioner, {
    organizationId: organizationB.id,
    userId: foreign.id,
    role: 'agency_admin',
    clientAccessMode: 'all_clients',
  });

  config = createAuthConfig({ ...TEST_AUTH_ENV, AUTH_LOGIN_RATE_LIMIT_ACCOUNT_MAX: '50' });

  app = buildApp({
    logger: createLogger({ name: 'api-authz-int', level: 'trace' }, destination),
    serviceVersion: '0.0.0-test',
    auth: buildAuthDependencies({ store: createAuthStore(database.runtime.db), config }),
    authorization: createAuthorizationService({
      db: database.runtime.db,
      store: createMembershipStore(database.runtime.db),
    }),
  });

  await app.ready();

  fixture = {
    orgA: organizationA.id,
    orgB: organizationB.id,
    adminEmail: admin.email,
    viewerEmail: viewer.email,
    outsiderEmail: outsider.email,
    foreignEmail: foreign.email,
    platformAdminEmail: platformAdmin.email,
    viewerMembershipId: viewerMembership.id,
    viewerUserId: viewer.id,
  };
}, 240_000);

afterAll(async () => {
  await app?.close();
  await database?.close();
});

beforeEach(() => {
  jar = new CookieJar();
  logLines = [];
});

async function login(email: string): Promise<void> {
  jar.absorb(await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie: '' } }));

  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { ...jar.headersFor(config), 'content-type': 'application/json' },
    payload: { email, password: PASSWORD },
  });

  expect(response.statusCode).toBe(200);
  jar.absorb(response);
}

function get(url: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url, headers: { cookie: jar.header() } });
}

describe('a session establishes identity, not tenant authority', () => {
  it('authenticates a user who belongs to no organization at all', async () => {
    await login(fixture.outsiderEmail);

    const me = await get('/auth/me');
    expect(me.statusCode).toBe(200);

    const organizations = await get('/auth/organizations');
    expect(organizationListResponseSchema.parse(organizations.json())).toEqual({
      organizations: [],
    });

    // A valid session, and still no organization it can act in.
    const read = await get(`/organizations/${fixture.orgA}`);
    expect(read.statusCode).toBe(404);
  });

  it('never reports authorization data from /auth/me', async () => {
    await login(fixture.adminEmail);

    const body = (await get('/auth/me')).json<Record<string, unknown>>();

    expect(Object.keys(body).sort()).toEqual(['email', 'id', 'locale', 'name']);
    expect(JSON.stringify(body)).not.toContain(fixture.orgA);
  });
});

describe('organization selection', () => {
  it("lists the caller's own organizations and no others", async () => {
    await login(fixture.adminEmail);

    const body = organizationListResponseSchema.parse((await get('/auth/organizations')).json());

    expect(body.organizations.map((row) => row.organizationId)).toEqual([fixture.orgA]);
    expect(body.organizations[0]?.role).toBe('agency_admin');
    expect(body.organizations[0]?.clientAccessMode).toBe('all_clients');
  });

  it('requires the selection to be explicit', async () => {
    await login(fixture.adminEmail);

    // Belonging to exactly one organization does not make any other one readable, and
    // nothing about the session records a choice.
    expect((await get(`/organizations/${fixture.orgB}`)).statusCode).toBe(404);
  });
});

describe('reading an authorized organization', () => {
  it("returns the organization and the caller's own access", async () => {
    await login(fixture.adminEmail);

    const response = await get(`/organizations/${fixture.orgA}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');

    const body = organizationResponseSchema.parse(response.json());
    expect(body.id).toBe(fixture.orgA);
    expect(body.name).toBe('Api Authz A');
    expect(body.access.role).toBe('agency_admin');
    expect(body.access.permissions).toContain('member.remove');
  });

  it('reports a restricted role honestly', async () => {
    await login(fixture.viewerEmail);

    const body = organizationResponseSchema.parse(
      (await get(`/organizations/${fixture.orgA}`)).json(),
    );

    expect(body.access.role).toBe('client_viewer');
    expect(body.access.clientAccessMode).toBe('scoped');
    expect(body.access.permissions).not.toContain('member.remove');
    expect(body.access.permissions).not.toContain('client.create');
    expect(body.access.permissions).toContain('organization.read');
  });
});

describe('cross-tenant probing', () => {
  it('answers a foreign organization the same as one that does not exist', async () => {
    await login(fixture.adminEmail);

    const foreign = await get(`/organizations/${fixture.orgB}`);
    const absent = await get('/organizations/00000000-0000-4000-8000-000000000000');
    const malformed = await get('/organizations/not-a-uuid');

    for (const response of [foreign, absent, malformed]) {
      expect(response.statusCode).toBe(404);
    }

    const bodies = new Set(
      [foreign, absent, malformed].map((response) => {
        const problem = problemDetailsSchema.parse(response.json());
        return JSON.stringify({ ...problem, requestId: undefined, instance: undefined });
      }),
    );

    expect(bodies.size).toBe(1);
  });

  it('does not let a member of one organization read another', async () => {
    await login(fixture.foreignEmail);

    expect((await get(`/organizations/${fixture.orgA}`)).statusCode).toBe(404);
    expect((await get(`/organizations/${fixture.orgB}`)).statusCode).toBe(200);
  });
});

describe('platform administration', () => {
  it('grants a platform admin no organization access through normal routes', async () => {
    await login(fixture.platformAdminEmail);

    expect(organizationListResponseSchema.parse((await get('/auth/organizations')).json())).toEqual(
      { organizations: [] },
    );
    expect((await get(`/organizations/${fixture.orgA}`)).statusCode).toBe(404);
    expect((await get(`/organizations/${fixture.orgB}`)).statusCode).toBe(404);
  });
});

describe('membership changes take effect on the next request', () => {
  it('stops authorizing once the membership is removed, without touching the session', async () => {
    await login(fixture.viewerEmail);

    expect((await get(`/organizations/${fixture.orgA}`)).statusCode).toBe(200);

    const tenant: TenantContext = {
      organizationId: fixture.orgA,
      actor: { kind: 'system' },
    };

    await withTenantTransaction(database.runtime.db, tenant, async (repositories) => {
      expect(await repositories.memberships.delete(fixture.viewerMembershipId)).toBe(true);
    });

    // The session is still perfectly valid — authentication and authorization are
    // different questions — but there is nothing left to authorize.
    expect((await get('/auth/me')).statusCode).toBe(200);
    expect((await get(`/organizations/${fixture.orgA}`)).statusCode).toBe(404);
    expect(
      organizationListResponseSchema.parse((await get('/auth/organizations')).json()).organizations,
    ).toEqual([]);
  });
});

describe('logging', () => {
  it('records the refusal category without leaking it to the client', async () => {
    await login(fixture.adminEmail);

    const response = await get(`/organizations/${fixture.orgB}`);

    expect(response.body).not.toContain('no_membership');
    expect(logLines.join('\n')).toContain('authorization refused');
    expect(logLines.join('\n')).toContain('no_membership');
  });

  it('never logs a session token, cookie or CSRF token', async () => {
    await login(fixture.adminEmail);
    await get(`/organizations/${fixture.orgA}`);

    const output = logLines.join('\n');
    const sessionCookie = jar.get(config.cookies.sessionCookieName);

    expect(sessionCookie).toBeDefined();
    expect(output).not.toContain(sessionCookie ?? 'unreachable');
    expect(output).not.toContain('set-cookie');
    expect(output.toLowerCase()).not.toContain('password');
  });
});
