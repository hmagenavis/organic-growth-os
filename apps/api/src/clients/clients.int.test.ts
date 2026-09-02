import { createAuthConfig, type AuthConfig } from '@organic-os/auth';
import {
  clientListResponseSchema,
  clientResponseSchema,
  problemDetailsSchema,
} from '@organic-os/contracts';
import {
  createAuthorizationService,
  createAuthStore,
  createClientService,
  createMembershipStore,
  provisionMembership,
  provisionOrganization,
  provisionUser,
  withTenantTransaction,
  type AuditLogRecord,
  type MembershipRole,
  type TenantContext,
} from '@organic-os/database';
import { createTestDatabase, type TestDatabase } from '@organic-os/database/testing';
import { createLogger, type LogDestination } from '@organic-os/observability';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { buildApp } from '../app.js';
import { buildAuthDependencies } from '../auth/build.js';
import { CookieJar, TEST_AUTH_ENV, testPasswordHasher } from '../testing/auth-helpers.js';

/**
 * The client API over HTTP, against real PostgreSQL.
 *
 * The database suite proves what the authorized transaction decides. This proves what
 * a browser sees: that the whole flow works with cookies and CSRF tokens, that every
 * role gets exactly the reach the permission policy states, and that a client of
 * another tenant and a client outside the caller's own scope answer with the *same
 * bytes* — which is the property that stops an authorization boundary being used to
 * enumerate resource ids.
 */

const PASSWORD = 'correct horse battery staple';

let database: TestDatabase;
let app: FastifyInstance;
let config: AuthConfig;
let logLines: string[];

interface Actor {
  email: string;
  userId: string;
  membershipId: string;
}

interface Fixture {
  orgA: string;
  orgB: string;
  a1: string;
  a2: string;
  a3: string;
  b1: string;
  admin: Actor;
  scopedAdmin: Actor;
  manager: Actor;
  editor: Actor;
  analyst: Actor;
  viewer: Actor;
  emptyViewer: Actor;
  platformAdmin: Actor;
  foreignAdmin: Actor;
}

let fixture: Fixture;

const destination: LogDestination = {
  write(chunk: string): void {
    logLines.push(chunk);
  },
};

beforeAll(async () => {
  logLines = [];
  database = await createTestDatabase(inject('postgresAdminUri'), 'organic_os_api_client_test');

  const provisioner = database.provisioner.db;
  const passwordHash = await testPasswordHasher.hash(PASSWORD);

  const organizationA = await provisionOrganization(provisioner, {
    name: 'Api Client A',
    slug: 'api-client-a',
  });
  const organizationB = await provisionOrganization(provisioner, {
    name: 'Api Client B',
    slug: 'api-client-b',
  });

  async function actor(
    organizationId: string,
    handle: string,
    role: MembershipRole,
    clientAccessMode: 'all_clients' | 'scoped',
    isPlatformAdmin = false,
  ): Promise<Actor> {
    const user = await provisionUser(provisioner, {
      email: `${handle}@example.test`,
      name: handle,
      passwordHash,
      isPlatformAdmin,
    });

    const membership = await provisionMembership(provisioner, {
      organizationId,
      userId: user.id,
      role,
      clientAccessMode,
    });

    return { email: user.email, userId: user.id, membershipId: membership.id };
  }

  const admin = await actor(organizationA.id, 'api-client-admin', 'agency_admin', 'all_clients');
  const scopedAdmin = await actor(
    organizationA.id,
    'api-client-admin-scoped',
    'agency_admin',
    'scoped',
  );
  const manager = await actor(organizationA.id, 'api-client-manager', 'seo_manager', 'all_clients');
  const editor = await actor(
    organizationA.id,
    'api-client-editor',
    'content_editor',
    'all_clients',
  );
  const analyst = await actor(organizationA.id, 'api-client-analyst', 'analyst', 'all_clients');
  const viewer = await actor(organizationA.id, 'api-client-viewer', 'client_viewer', 'scoped');
  const emptyViewer = await actor(
    organizationA.id,
    'api-client-viewer-empty',
    'client_viewer',
    'scoped',
  );
  const platformAdmin = await actor(
    organizationB.id,
    'api-client-platform',
    'agency_admin',
    'all_clients',
    true,
  );
  const foreignAdmin = await actor(
    organizationB.id,
    'api-client-foreign',
    'agency_admin',
    'all_clients',
  );

  const tenantA: TenantContext = {
    organizationId: organizationA.id,
    actor: { kind: 'user', userId: admin.userId },
  };
  const tenantB: TenantContext = {
    organizationId: organizationB.id,
    actor: { kind: 'user', userId: foreignAdmin.userId },
  };

  // One transaction per client so `created_at` strictly increases and the fixture's
  // order is the listing order.
  const created: string[] = [];

  for (const name of ['API A1', 'API A2', 'API A3']) {
    created.push(
      await withTenantTransaction(
        database.runtime.db,
        tenantA,
        async (repositories) => (await repositories.clients.create({ name })).id,
      ),
    );
  }

  const [a1, a2, a3] = created;

  if (a1 === undefined || a2 === undefined || a3 === undefined) {
    throw new Error('fixture did not create three clients');
  }

  await withTenantTransaction(database.runtime.db, tenantA, async (repositories) => {
    await repositories.membershipClientScopes.add({
      membershipId: viewer.membershipId,
      clientId: a1,
    });
    await repositories.membershipClientScopes.add({
      membershipId: scopedAdmin.membershipId,
      clientId: a2,
    });
  });

  const b1 = await withTenantTransaction(
    database.runtime.db,
    tenantB,
    async (repositories) => (await repositories.clients.create({ name: 'API B1' })).id,
  );

  config = createAuthConfig({ ...TEST_AUTH_ENV, AUTH_LOGIN_RATE_LIMIT_ACCOUNT_MAX: '80' });

  const authorization = createAuthorizationService({
    db: database.runtime.db,
    store: createMembershipStore(database.runtime.db),
  });

  app = buildApp({
    logger: createLogger({ name: 'api-client-int', level: 'trace' }, destination),
    serviceVersion: '0.0.0-test',
    auth: buildAuthDependencies({ store: createAuthStore(database.runtime.db), config }),
    authorization,
    clients: createClientService({ authorization }),
  });

  await app.ready();

  fixture = {
    orgA: organizationA.id,
    orgB: organizationB.id,
    a1,
    a2,
    a3,
    b1,
    admin,
    scopedAdmin,
    manager,
    editor,
    analyst,
    viewer,
    emptyViewer,
    platformAdmin,
    foreignAdmin,
  };
}, 240_000);

afterAll(async () => {
  await app?.close();
  await database?.close();
});

/** One browser: its own cookie jar, its own session. */
async function signIn(email: string): Promise<CookieJar> {
  const jar = new CookieJar();

  jar.absorb(await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie: '' } }));

  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { ...jar.headersFor(config), 'content-type': 'application/json' },
    payload: { email, password: PASSWORD },
  });

  expect(response.statusCode).toBe(200);
  jar.absorb(response);

  return jar;
}

async function get(jar: CookieJar, url: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url, headers: { cookie: jar.header() } });
}

async function mutate(
  jar: CookieJar,
  method: 'POST' | 'PATCH',
  url: string,
  payload: object,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: { ...jar.headersFor(config), 'content-type': 'application/json' },
    payload,
  });
}

function clientsUrl(organizationId: string): string {
  return `/organizations/${organizationId}/clients`;
}

function clientUrl(organizationId: string, clientId: string): string {
  return `${clientsUrl(organizationId)}/${clientId}`;
}

async function listedIds(jar: CookieJar, organizationId: string, query = ''): Promise<string[]> {
  const response = await get(jar, `${clientsUrl(organizationId)}${query}`);

  expect(response.statusCode).toBe(200);

  return clientListResponseSchema.parse(response.json()).clients.map((client) => client.id);
}

async function auditRows(organizationId: string, userId: string): Promise<AuditLogRecord[]> {
  const tenant: TenantContext = { organizationId, actor: { kind: 'user', userId } };

  return withTenantTransaction(database.runtime.db, tenant, async (repositories) =>
    repositories.auditLogs.list(1000),
  );
}

describe('the read matrix', () => {
  it('gives an all_clients agency admin every client of the organization', async () => {
    const jar = await signIn(fixture.admin.email);

    expect(await listedIds(jar, fixture.orgA)).toEqual([fixture.a1, fixture.a2, fixture.a3]);

    const single = await get(jar, clientUrl(fixture.orgA, fixture.a3));
    expect(single.statusCode).toBe(200);
    expect(clientResponseSchema.parse(single.json()).client.id).toBe(fixture.a3);
  });

  it('gives a scoped agency admin only its scoped clients', async () => {
    const jar = await signIn(fixture.scopedAdmin.email);

    expect(await listedIds(jar, fixture.orgA)).toEqual([fixture.a2]);
    expect((await get(jar, clientUrl(fixture.orgA, fixture.a1))).statusCode).toBe(404);
  });

  it.each(['manager', 'editor', 'analyst'] as const)(
    'lets a %s read but refuses it every write',
    async (key) => {
      const jar = await signIn(fixture[key].email);

      expect(await listedIds(jar, fixture.orgA)).toHaveLength(3);
      expect((await get(jar, clientUrl(fixture.orgA, fixture.a1))).statusCode).toBe(200);

      expect(
        (await mutate(jar, 'POST', clientsUrl(fixture.orgA), { name: 'Nope' })).statusCode,
      ).toBe(403);
      expect(
        (await mutate(jar, 'PATCH', clientUrl(fixture.orgA, fixture.a1), { name: 'Nope' }))
          .statusCode,
      ).toBe(403);
    },
  );

  it('gives a client_viewer its scoped client and nothing else', async () => {
    const jar = await signIn(fixture.viewer.email);

    expect(await listedIds(jar, fixture.orgA)).toEqual([fixture.a1]);
    expect((await get(jar, clientUrl(fixture.orgA, fixture.a1))).statusCode).toBe(200);
    expect((await get(jar, clientUrl(fixture.orgA, fixture.a2))).statusCode).toBe(404);

    expect((await mutate(jar, 'POST', clientsUrl(fixture.orgA), { name: 'Nope' })).statusCode).toBe(
      403,
    );
    expect(
      (await mutate(jar, 'PATCH', clientUrl(fixture.orgA, fixture.a1), { name: 'Nope' }))
        .statusCode,
    ).toBe(403);
  });

  it('gives a client_viewer with zero scope rows exactly zero clients', async () => {
    const jar = await signIn(fixture.emptyViewer.email);

    expect(await listedIds(jar, fixture.orgA)).toEqual([]);
    expect((await get(jar, clientUrl(fixture.orgA, fixture.a1))).statusCode).toBe(404);
  });

  it('refuses an unauthenticated read', async () => {
    const response = await app.inject({ method: 'GET', url: clientsUrl(fixture.orgA) });

    expect(response.statusCode).toBe(401);
  });
});

describe('cross-tenant probing learns nothing', () => {
  it('refuses to list or read another organization', async () => {
    const jar = await signIn(fixture.admin.email);

    expect((await get(jar, clientsUrl(fixture.orgB))).statusCode).toBe(404);
    expect((await get(jar, clientUrl(fixture.orgB, fixture.b1))).statusCode).toBe(404);
    expect(
      (await mutate(jar, 'PATCH', clientUrl(fixture.orgB, fixture.b1), { name: 'Nope' }))
        .statusCode,
    ).toBe(404);
    expect((await mutate(jar, 'POST', clientsUrl(fixture.orgB), { name: 'Nope' })).statusCode).toBe(
      404,
    );
  });

  it('refuses a foreign client id presented under the caller own organization', async () => {
    const jar = await signIn(fixture.admin.email);

    expect((await get(jar, clientUrl(fixture.orgA, fixture.b1))).statusCode).toBe(404);
  });

  it('answers foreign, absent, malformed and out-of-scope with identical bodies', async () => {
    // The scoped admin can reach a2 and nothing else, so all four of these are
    // resources it cannot reach — for four different internal reasons.
    const jar = await signIn(fixture.scopedAdmin.email);

    const responses = await Promise.all([
      get(jar, clientUrl(fixture.orgA, fixture.b1)),
      get(jar, clientUrl(fixture.orgA, '018f9e1a-0000-7000-8000-00000000dead')),
      get(jar, clientUrl(fixture.orgA, 'not-a-uuid')),
      get(jar, clientUrl(fixture.orgA, fixture.a1)),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/problem+json');
    }

    // `instance` echoes the URL, which the caller already knows; everything else must
    // be byte-identical, and no `code` may discriminate the four causes.
    const bodies = responses.map((response) => {
      const problem = problemDetailsSchema.parse(response.json());
      return JSON.stringify({
        type: problem.type,
        title: problem.title,
        status: problem.status,
        detail: problem.detail,
        code: problem.code,
      });
    });

    expect(new Set(bodies).size).toBe(1);
    expect(problemDetailsSchema.parse(responses[0]?.json()).code).toBeUndefined();
  });

  it('refuses a forged organization id', async () => {
    const jar = await signIn(fixture.admin.email);

    for (const forged of [
      '018f9e1a-0000-7000-8000-0000000000ff',
      'not-a-uuid',
      '../' + fixture.orgB,
    ]) {
      const response = await get(jar, clientsUrl(encodeURIComponent(forged)));
      expect(response.statusCode).toBe(404);
    }
  });

  it('does not let a platform administrator bypass organization membership', async () => {
    // `is_platform_admin` is not an organization role. This user administers
    // organization B and holds nothing at all in organization A.
    const jar = await signIn(fixture.platformAdmin.email);

    expect((await get(jar, clientsUrl(fixture.orgA))).statusCode).toBe(404);
    expect((await get(jar, clientUrl(fixture.orgA, fixture.a1))).statusCode).toBe(404);
    expect((await mutate(jar, 'POST', clientsUrl(fixture.orgA), { name: 'Nope' })).statusCode).toBe(
      404,
    );

    // ... and its own organization still works, through ordinary membership.
    expect(await listedIds(jar, fixture.orgB)).toEqual([fixture.b1]);
  });
});

describe('creating and updating', () => {
  it('creates, audits once, and never trusts a body organization id', async () => {
    const jar = await signIn(fixture.admin.email);

    const rejected = await mutate(jar, 'POST', clientsUrl(fixture.orgA), {
      name: 'Injected',
      organizationId: fixture.orgB,
    });
    expect(rejected.statusCode).toBe(400);

    const before = await auditRows(fixture.orgA, fixture.admin.userId);

    const created = await mutate(jar, 'POST', clientsUrl(fixture.orgA), {
      name: 'Created Over HTTP',
      industry: 'retail',
    });

    expect(created.statusCode).toBe(201);
    const body = clientResponseSchema.parse(created.json()).client;
    expect(body.name).toBe('Created Over HTTP');
    expect(body.status).toBe('active');

    const after = await auditRows(fixture.orgA, fixture.admin.userId);
    const added = after.filter((row) => !before.some((existing) => existing.id === row.id));

    expect(added).toHaveLength(1);
    expect(added[0]?.action).toBe('client.created');
    expect(added[0]?.targetId).toBe(body.id);
    expect(added[0]?.actorMembershipId).toBe(fixture.admin.membershipId);

    // Created in organization A, and organization B never sees it.
    const foreign = await signIn(fixture.foreignAdmin.email);
    expect(await listedIds(foreign, fixture.orgB)).toEqual([fixture.b1]);
  });

  it('does not add a new client to a scoped membership', async () => {
    const admin = await signIn(fixture.admin.email);
    const viewer = await signIn(fixture.viewer.email);

    const scopedBefore = await listedIds(viewer, fixture.orgA);

    const created = await mutate(admin, 'POST', clientsUrl(fixture.orgA), {
      name: 'Still Not Shared',
    });
    expect(created.statusCode).toBe(201);
    const createdId = clientResponseSchema.parse(created.json()).client.id;

    expect(await listedIds(viewer, fixture.orgA)).toEqual(scopedBefore);
    expect((await get(viewer, clientUrl(fixture.orgA, createdId))).statusCode).toBe(404);

    // The all_clients admin does see it, by policy rather than by a scope row.
    expect(await listedIds(admin, fixture.orgA, '?limit=100')).toContain(createdId);
  });

  it('updates a reachable client and audits before/after', async () => {
    const jar = await signIn(fixture.admin.email);

    const created = await mutate(jar, 'POST', clientsUrl(fixture.orgA), {
      name: 'Patch Target',
      notes: 'a private note',
    });
    const target = clientResponseSchema.parse(created.json()).client;

    const patched = await mutate(jar, 'PATCH', clientUrl(fixture.orgA, target.id), {
      name: 'Patched Name',
      notes: null,
    });

    expect(patched.statusCode).toBe(200);
    const updated = clientResponseSchema.parse(patched.json()).client;
    expect(updated.name).toBe('Patched Name');
    expect(updated.notes).toBeNull();

    const rows = await auditRows(fixture.orgA, fixture.admin.userId);
    const entry = rows.find((row) => row.action === 'client.updated' && row.targetId === target.id);

    expect(entry?.before).toEqual({
      name: 'Patch Target',
      status: 'active',
      industry: null,
      notesPresent: true,
    });
    expect(entry?.after).toEqual({
      name: 'Patched Name',
      status: 'active',
      industry: null,
      notesPresent: false,
    });
    // The note text never enters the append-only trail.
    expect(JSON.stringify(rows)).not.toContain('a private note');
  });

  it('refuses a scoped agency admin an unscoped client', async () => {
    const jar = await signIn(fixture.scopedAdmin.email);

    expect(
      (await mutate(jar, 'PATCH', clientUrl(fixture.orgA, fixture.a3), { name: 'Reached' }))
        .statusCode,
    ).toBe(404);

    const allowed = await mutate(jar, 'PATCH', clientUrl(fixture.orgA, fixture.a2), {
      industry: 'freight',
    });
    expect(allowed.statusCode).toBe(200);
    expect(clientResponseSchema.parse(allowed.json()).client.industry).toBe('freight');
  });

  it.each([
    { organizationId: '018f9e1a-0000-7000-8000-0000000000ff' },
    { id: '018f9e1a-0000-7000-8000-0000000000ff' },
    { status: 'archived' },
    { createdAt: '2026-01-01T00:00:00.000Z' },
    { somethingElse: 1 },
    {},
  ])('refuses the immutable or unknown patch %j', async (payload) => {
    const jar = await signIn(fixture.admin.email);

    const response = await mutate(jar, 'PATCH', clientUrl(fixture.orgA, fixture.a1), payload);

    expect(response.statusCode).toBe(400);
  });

  it('writes no audit row for a refused mutation', async () => {
    const manager = await signIn(fixture.manager.email);
    const before = await auditRows(fixture.orgA, fixture.admin.userId);

    expect(
      (await mutate(manager, 'PATCH', clientUrl(fixture.orgA, fixture.a1), { name: 'Refused' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await mutate(manager, 'POST', clientsUrl(fixture.orgA), { name: 'Refused' })).statusCode,
    ).toBe(403);

    const after = await auditRows(fixture.orgA, fixture.admin.userId);

    expect(after).toHaveLength(before.length);
    expect(JSON.stringify(after)).not.toContain('Refused');
  });

  it('requires a CSRF token for every write', async () => {
    const jar = await signIn(fixture.admin.email);

    const response = await app.inject({
      method: 'POST',
      url: clientsUrl(fixture.orgA),
      headers: { cookie: jar.header(), 'content-type': 'application/json' },
      payload: { name: 'No CSRF' },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('pagination', () => {
  it('bounds the page and pages deterministically', async () => {
    const jar = await signIn(fixture.admin.email);

    const all = await listedIds(jar, fixture.orgA, '?limit=100');
    expect(all.length).toBeGreaterThan(3);

    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      const url: string =
        cursor === null
          ? `${clientsUrl(fixture.orgA)}?limit=2`
          : `${clientsUrl(fixture.orgA)}?limit=2&cursor=${encodeURIComponent(cursor)}`;

      const response = await get(jar, url);
      expect(response.statusCode).toBe(200);

      const page = clientListResponseSchema.parse(response.json());
      expect(page.clients.length).toBeLessThanOrEqual(2);
      expect(page.page.limit).toBe(2);

      seen.push(...page.clients.map((client) => client.id));
      cursor = page.page.nextCursor;
    } while (cursor !== null);

    expect(seen).toEqual(all);
  });

  it('applies the default limit and refuses an over-maximum one', async () => {
    const jar = await signIn(fixture.admin.email);

    const defaulted = await get(jar, clientsUrl(fixture.orgA));
    expect(clientListResponseSchema.parse(defaulted.json()).page.limit).toBe(50);

    expect((await get(jar, `${clientsUrl(fixture.orgA)}?limit=100`)).statusCode).toBe(200);
    expect((await get(jar, `${clientsUrl(fixture.orgA)}?limit=101`)).statusCode).toBe(400);
    expect((await get(jar, `${clientsUrl(fixture.orgA)}?limit=0`)).statusCode).toBe(400);
    expect((await get(jar, `${clientsUrl(fixture.orgA)}?cursor=nonsense`)).statusCode).toBe(400);
  });

  it('never reports a count of rows the caller cannot reach', async () => {
    const jar = await signIn(fixture.viewer.email);

    const response = await get(jar, clientsUrl(fixture.orgA));
    const page = clientListResponseSchema.parse(response.json());

    expect(page.clients).toHaveLength(1);
    expect(page.page.nextCursor).toBeNull();
    // The contract has no total: there is nothing here that counts the organization.
    expect(Object.keys(page.page).sort()).toEqual(['limit', 'nextCursor']);
  });

  it('refuses a cursor before authorizing nothing extra', async () => {
    // An unauthenticated caller never gets as far as cursor validation.
    const response = await app.inject({
      method: 'GET',
      url: `${clientsUrl(fixture.orgA)}?cursor=nonsense`,
    });

    expect(response.statusCode).toBe(401);
  });
});
