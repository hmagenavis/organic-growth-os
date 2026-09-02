import { createAuthConfig, type AuthConfig } from '@organic-os/auth';
import {
  problemDetailsSchema,
  siteListResponseSchema,
  siteResponseSchema,
} from '@organic-os/contracts';
import {
  createAuthorizationService,
  createAuthStore,
  createClientService,
  createMembershipStore,
  createSiteService,
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
 * The site API over HTTP, against real PostgreSQL.
 *
 * The database suite proves what the authorized transaction decides. This proves what
 * a browser sees: that the nested route works with cookies and CSRF tokens, that a
 * site is reachable exactly when its parent client is, that a created site comes back
 * in `review` with a settings row behind it, and that every way of naming a site the
 * caller may not have — another tenant's, another client's, one outside the caller's
 * scope, one that does not exist, one whose id is malformed — answers with the *same
 * bytes*.
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
  cA1: string;
  cA2: string;
  s1: string;
  s2: string;
  s3: string;
  s2a: string;
  cB1: string;
  sB1: string;
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
  database = await createTestDatabase(inject('postgresAdminUri'), 'organic_os_api_site_test');

  const provisioner = database.provisioner.db;
  const passwordHash = await testPasswordHasher.hash(PASSWORD);

  const organizationA = await provisionOrganization(provisioner, {
    name: 'Api Site A',
    slug: 'api-site-a',
  });
  const organizationB = await provisionOrganization(provisioner, {
    name: 'Api Site B',
    slug: 'api-site-b',
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

  const admin = await actor(organizationA.id, 'api-site-admin', 'agency_admin', 'all_clients');
  const scopedAdmin = await actor(
    organizationA.id,
    'api-site-admin-scoped',
    'agency_admin',
    'scoped',
  );
  const manager = await actor(organizationA.id, 'api-site-manager', 'seo_manager', 'all_clients');
  const editor = await actor(organizationA.id, 'api-site-editor', 'content_editor', 'all_clients');
  const analyst = await actor(organizationA.id, 'api-site-analyst', 'analyst', 'all_clients');
  const viewer = await actor(organizationA.id, 'api-site-viewer', 'client_viewer', 'scoped');
  const emptyViewer = await actor(
    organizationA.id,
    'api-site-viewer-empty',
    'client_viewer',
    'scoped',
  );
  const platformAdmin = await actor(
    organizationB.id,
    'api-site-platform',
    'agency_admin',
    'all_clients',
    true,
  );
  const foreignAdmin = await actor(
    organizationB.id,
    'api-site-foreign',
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

  const { cA1, cA2 } = await withTenantTransaction(
    database.runtime.db,
    tenantA,
    async (repositories) => ({
      cA1: (await repositories.clients.create({ name: 'Api Site Client A1' })).id,
      cA2: (await repositories.clients.create({ name: 'Api Site Client A2' })).id,
    }),
  );

  await withTenantTransaction(database.runtime.db, tenantA, async (repositories) => {
    await repositories.membershipClientScopes.add({
      membershipId: viewer.membershipId,
      clientId: cA1,
    });
    await repositories.membershipClientScopes.add({
      membershipId: scopedAdmin.membershipId,
      clientId: cA2,
    });
  });

  const cB1 = await withTenantTransaction(
    database.runtime.db,
    tenantB,
    async (repositories) => (await repositories.clients.create({ name: 'Api Site Client B1' })).id,
  );

  config = createAuthConfig({ ...TEST_AUTH_ENV, AUTH_LOGIN_RATE_LIMIT_ACCOUNT_MAX: '120' });

  const authorization = createAuthorizationService({
    db: database.runtime.db,
    store: createMembershipStore(database.runtime.db),
  });
  const siteService = createSiteService({ authorization });

  app = buildApp({
    logger: createLogger({ name: 'api-site-int', level: 'trace' }, destination),
    serviceVersion: '0.0.0-test',
    auth: buildAuthDependencies({ store: createAuthStore(database.runtime.db), config }),
    authorization,
    clients: createClientService({ authorization }),
    sites: siteService,
  });

  await app.ready();

  // Seeded through the service, one transaction at a time, so `created_at` strictly
  // increases and every fixture site carries the settings row it would in production.
  const seeded: string[] = [];

  for (const index of [1, 2, 3]) {
    seeded.push(
      (
        await siteService.createSite(
          { userId: admin.userId },
          organizationA.id,
          cA1,
          { baseUrl: `https://api-a1-${index}.example.test` },
          { source: 'api', ip: '198.51.100.10' },
        )
      ).id,
    );
  }

  const [s1, s2, s3] = seeded;

  const s2a = (
    await siteService.createSite(
      { userId: admin.userId },
      organizationA.id,
      cA2,
      { baseUrl: 'https://api-a2-1.example.test' },
      { source: 'api', ip: '198.51.100.10' },
    )
  ).id;

  const sB1 = (
    await siteService.createSite(
      { userId: foreignAdmin.userId },
      organizationB.id,
      cB1,
      { baseUrl: 'https://api-b1-1.example.test' },
      { source: 'api', ip: '198.51.100.10' },
    )
  ).id;

  if (s1 === undefined || s2 === undefined || s3 === undefined) {
    throw new Error('fixture did not create three sites');
  }

  fixture = {
    orgA: organizationA.id,
    orgB: organizationB.id,
    cA1,
    cA2,
    s1,
    s2,
    s3,
    s2a,
    cB1,
    sB1,
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

function sitesUrl(organizationId: string, clientId: string): string {
  return `/organizations/${organizationId}/clients/${clientId}/sites`;
}

function siteUrl(organizationId: string, clientId: string, siteId: string): string {
  return `${sitesUrl(organizationId, clientId)}/${siteId}`;
}

async function listedIds(
  jar: CookieJar,
  organizationId: string,
  clientId: string,
  query = '',
): Promise<string[]> {
  const response = await get(jar, `${sitesUrl(organizationId, clientId)}${query}`);

  expect(response.statusCode).toBe(200);

  return siteListResponseSchema.parse(response.json()).sites.map((site) => site.id);
}

async function auditRows(organizationId: string, userId: string): Promise<AuditLogRecord[]> {
  const tenant: TenantContext = { organizationId, actor: { kind: 'user', userId } };

  return withTenantTransaction(database.runtime.db, tenant, async (repositories) =>
    repositories.auditLogs.list(1000),
  );
}

/** The identifying half of a problem document — everything but the per-request fields. */
function shape(response: LightMyRequestResponse): unknown {
  const problem = problemDetailsSchema.parse(response.json());

  return {
    type: problem.type,
    title: problem.title,
    status: problem.status,
    detail: problem.detail,
    code: problem.code,
  };
}

describe('authentication and CSRF come first', () => {
  it('refuses every route without a session', async () => {
    const empty = new CookieJar();

    for (const url of [
      sitesUrl(fixture.orgA, fixture.cA1),
      siteUrl(fixture.orgA, fixture.cA1, fixture.s1),
    ]) {
      expect((await get(empty, url)).statusCode).toBe(401);
    }
  });

  it('refuses a write that carries a session but no CSRF token', async () => {
    const jar = await signIn(fixture.admin.email);

    const response = await app.inject({
      method: 'POST',
      url: sitesUrl(fixture.orgA, fixture.cA1),
      headers: { cookie: jar.header(), 'content-type': 'application/json' },
      payload: { baseUrl: 'https://csrf.example.test' },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('the read matrix', () => {
  it('gives an all_clients agency admin every site of a reachable client', async () => {
    const jar = await signIn(fixture.admin.email);

    expect(await listedIds(jar, fixture.orgA, fixture.cA1)).toEqual([
      fixture.s1,
      fixture.s2,
      fixture.s3,
    ]);
    expect(await listedIds(jar, fixture.orgA, fixture.cA2)).toEqual([fixture.s2a]);

    const single = await get(jar, siteUrl(fixture.orgA, fixture.cA1, fixture.s2));
    const body = siteResponseSchema.parse(single.json());

    expect(single.statusCode).toBe(200);
    expect(body.site.id).toBe(fixture.s2);
    expect(body.site.autopilotMode).toBe('review');
    expect(Object.keys(body.site)).not.toContain('organizationId');
    expect(Object.keys(body.site)).not.toContain('clientId');
  });

  it('gives a scoped agency admin only the sites under its scoped client', async () => {
    const jar = await signIn(fixture.scopedAdmin.email);

    expect(await listedIds(jar, fixture.orgA, fixture.cA2)).toEqual([fixture.s2a]);
    expect((await get(jar, sitesUrl(fixture.orgA, fixture.cA1))).statusCode).toBe(404);
    expect((await get(jar, siteUrl(fixture.orgA, fixture.cA1, fixture.s1))).statusCode).toBe(404);
  });

  it.each(['manager', 'editor', 'analyst'] as const)(
    'lets a %s read but refuses it every write',
    async (key) => {
      const jar = await signIn(fixture[key].email);

      expect(await listedIds(jar, fixture.orgA, fixture.cA1)).toHaveLength(3);
      expect((await get(jar, siteUrl(fixture.orgA, fixture.cA1, fixture.s1))).statusCode).toBe(200);

      expect(
        (
          await mutate(jar, 'POST', sitesUrl(fixture.orgA, fixture.cA1), {
            baseUrl: 'https://denied.example.test',
          })
        ).statusCode,
      ).toBe(403);

      expect(
        (
          await mutate(jar, 'PATCH', siteUrl(fixture.orgA, fixture.cA1, fixture.s1), {
            timezone: 'UTC',
          })
        ).statusCode,
      ).toBe(403);
    },
  );

  it('gives a client_viewer its scoped client only, and refuses it writes', async () => {
    const jar = await signIn(fixture.viewer.email);

    expect(await listedIds(jar, fixture.orgA, fixture.cA1)).toHaveLength(3);
    expect((await get(jar, sitesUrl(fixture.orgA, fixture.cA2))).statusCode).toBe(404);
    expect(
      (
        await mutate(jar, 'POST', sitesUrl(fixture.orgA, fixture.cA1), {
          baseUrl: 'https://viewer.example.test',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('gives a scoped membership with zero scope rows nothing at all', async () => {
    const jar = await signIn(fixture.emptyViewer.email);

    for (const clientId of [fixture.cA1, fixture.cA2]) {
      expect((await get(jar, sitesUrl(fixture.orgA, clientId))).statusCode).toBe(404);
    }
  });
});

describe('non-enumeration', () => {
  it('answers every unreachable site with one identical body', async () => {
    const jar = await signIn(fixture.admin.email);

    const responses = [
      // Does not exist.
      await get(jar, siteUrl(fixture.orgA, fixture.cA1, '018f9e1a-0000-7000-8000-00000000dead')),
      // Malformed id.
      await get(jar, siteUrl(fixture.orgA, fixture.cA1, 'not-a-uuid')),
      // Belongs to another organization.
      await get(jar, siteUrl(fixture.orgA, fixture.cA1, fixture.sB1)),
      // Real site of this organization, wrong parent client in the URL.
      await get(jar, siteUrl(fixture.orgA, fixture.cA2, fixture.s1)),
      // Parent client of another organization.
      await get(jar, siteUrl(fixture.orgA, fixture.cB1, fixture.s1)),
    ];

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
    }

    const bodies = responses.map(shape);

    for (const body of bodies) {
      expect(body).toEqual(bodies[0]);
    }

    // No machine-readable discriminator: one would rebuild exactly the oracle the
    // shared 404 exists to remove.
    expect(problemDetailsSchema.parse(responses[0]?.json()).code).toBeUndefined();
  });

  it('answers an out-of-scope parent client identically to a foreign one', async () => {
    const jar = await signIn(fixture.scopedAdmin.email);

    const outOfScope = await get(jar, siteUrl(fixture.orgA, fixture.cA1, fixture.s1));
    const foreign = await get(jar, siteUrl(fixture.orgA, fixture.cB1, fixture.sB1));

    expect(outOfScope.statusCode).toBe(404);
    expect(shape(outOfScope)).toEqual(shape(foreign));
  });

  it('refuses by role before it looks at a site id', async () => {
    // A seo_manager gets the same 403 whether the site exists or not, so a permission
    // refusal leaks nothing about existence either.
    const jar = await signIn(fixture.manager.email);

    const real = await mutate(jar, 'PATCH', siteUrl(fixture.orgA, fixture.cA1, fixture.s1), {
      timezone: 'UTC',
    });
    const absent = await mutate(
      jar,
      'PATCH',
      siteUrl(fixture.orgA, fixture.cA1, '018f9e1a-0000-7000-8000-00000000dead'),
      { timezone: 'UTC' },
    );

    expect(real.statusCode).toBe(403);
    expect(shape(real)).toEqual(shape(absent));
  });
});

describe('cross-tenant access', () => {
  it('refuses an organization A caller everything about organization B', async () => {
    const jar = await signIn(fixture.admin.email);

    expect((await get(jar, sitesUrl(fixture.orgB, fixture.cB1))).statusCode).toBe(404);
    expect((await get(jar, siteUrl(fixture.orgB, fixture.cB1, fixture.sB1))).statusCode).toBe(404);
    expect(
      (
        await mutate(jar, 'POST', sitesUrl(fixture.orgB, fixture.cB1), {
          baseUrl: 'https://intruder.example.test',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await mutate(jar, 'PATCH', siteUrl(fixture.orgB, fixture.cB1, fixture.sB1), {
          timezone: 'UTC',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('does not let a valid site id be paired with another client id to bypass ownership', async () => {
    const jar = await signIn(fixture.admin.email);

    const response = await mutate(jar, 'PATCH', siteUrl(fixture.orgA, fixture.cA2, fixture.s1), {
      timezone: 'Europe/London',
    });

    expect(response.statusCode).toBe(404);

    const unchanged = await get(jar, siteUrl(fixture.orgA, fixture.cA1, fixture.s1));
    expect(siteResponseSchema.parse(unchanged.json()).site.timezone).toBe('UTC');
  });

  it('gives a platform administrator no authority outside its own organization', async () => {
    const jar = await signIn(fixture.platformAdmin.email);

    expect((await get(jar, sitesUrl(fixture.orgA, fixture.cA1))).statusCode).toBe(404);
    expect((await get(jar, siteUrl(fixture.orgA, fixture.cA1, fixture.s1))).statusCode).toBe(404);
    expect(
      (
        await mutate(jar, 'POST', sitesUrl(fixture.orgA, fixture.cA1), {
          baseUrl: 'https://platform.example.test',
        })
      ).statusCode,
    ).toBe(404);

    // And is an ordinary administrator where it does hold a membership.
    expect(await listedIds(jar, fixture.orgB, fixture.cB1)).toEqual([fixture.sB1]);
  });
});

describe('creating a site', () => {
  it('creates in review, with a settings row and exactly one audit record', async () => {
    const jar = await signIn(fixture.admin.email);

    const response = await mutate(jar, 'POST', sitesUrl(fixture.orgA, fixture.cA1), {
      baseUrl: '  HTTPS://Created.Example.Test/  ',
      timezone: 'asia/jerusalem',
      language: 'he',
    });

    expect(response.statusCode).toBe(201);

    const site = siteResponseSchema.parse(response.json()).site;

    expect(site.baseUrl).toBe('https://created.example.test');
    expect(site.timezone).toBe('Asia/Jerusalem');
    expect(site.language).toBe('he');
    expect(site.autopilotMode).toBe('review');
    expect(site.status).toBe('active');
    expect(site.cmsType).toBe('wordpress');

    const settings = await withTenantTransaction(
      database.runtime.db,
      { organizationId: fixture.orgA, actor: { kind: 'user', userId: fixture.admin.userId } },
      async (repositories) => repositories.siteSettings.findBySiteId(site.id),
    );

    expect(settings?.autopilotMode).toBe('review');

    const rows = (await auditRows(fixture.orgA, fixture.admin.userId)).filter(
      (row) => row.targetId === site.id,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('site.created');
    expect(rows[0]?.after).toMatchObject({
      clientId: fixture.cA1,
      autopilotMode: 'review',
      autopilotModeSource: 'system_policy',
    });
  });

  it('refuses a body that tries to choose an autopilot mode', async () => {
    const jar = await signIn(fixture.admin.email);

    for (const payload of [
      { baseUrl: 'https://mode.example.test', autopilotMode: 'safe_autopilot' },
      { baseUrl: 'https://mode.example.test', autopilot_mode: 'full_autopilot' },
      { baseUrl: 'https://mode.example.test', siteSettings: { autopilotMode: 'off' } },
    ]) {
      const response = await mutate(jar, 'POST', sitesUrl(fixture.orgA, fixture.cA1), payload);
      expect(response.statusCode).toBe(400);
    }

    // And nothing was created under any of those attempts.
    const listed = await listedIds(jar, fixture.orgA, fixture.cA1, '?limit=100');
    const created = await Promise.all(
      listed.map(async (id) => {
        const single = await get(jar, siteUrl(fixture.orgA, fixture.cA1, id));
        return siteResponseSchema.parse(single.json()).site.baseUrl;
      }),
    );

    expect(created).not.toContain('https://mode.example.test');
  });

  it('refuses an injected organization or client id', async () => {
    const jar = await signIn(fixture.admin.email);

    for (const payload of [
      { baseUrl: 'https://injected.example.test', organizationId: fixture.orgB },
      { baseUrl: 'https://injected.example.test', clientId: fixture.cA2 },
      { baseUrl: 'https://injected.example.test', id: fixture.s1 },
    ]) {
      expect(
        (await mutate(jar, 'POST', sitesUrl(fixture.orgA, fixture.cA1), payload)).statusCode,
      ).toBe(400);
    }
  });

  it('refuses a base URL it cannot normalize, without echoing it back', async () => {
    const jar = await signIn(fixture.admin.email);

    const response = await mutate(jar, 'POST', sitesUrl(fixture.orgA, fixture.cA1), {
      baseUrl: 'ftp://example.test',
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('ftp://example.test');
  });

  it('answers a duplicate base URL with 409 naming no other resource', async () => {
    const jar = await signIn(fixture.admin.email);

    const first = await mutate(jar, 'POST', sitesUrl(fixture.orgA, fixture.cA1), {
      baseUrl: 'https://api-duplicate.example.test',
    });
    expect(first.statusCode).toBe(201);

    const second = await mutate(jar, 'POST', sitesUrl(fixture.orgA, fixture.cA2), {
      baseUrl: 'https://API-Duplicate.example.test/',
    });

    expect(second.statusCode).toBe(409);

    const problem = problemDetailsSchema.parse(second.json());
    expect(problem.detail).not.toContain(fixture.cA1);
    expect(problem.detail).not.toContain(fixture.s1);
  });

  it('lets a scoped agency admin create only under its scoped client', async () => {
    const jar = await signIn(fixture.scopedAdmin.email);

    expect(
      (
        await mutate(jar, 'POST', sitesUrl(fixture.orgA, fixture.cA1), {
          baseUrl: 'https://api-scoped-denied.example.test',
        })
      ).statusCode,
    ).toBe(404);

    const allowed = await mutate(jar, 'POST', sitesUrl(fixture.orgA, fixture.cA2), {
      baseUrl: 'https://api-scoped-allowed.example.test',
    });

    expect(allowed.statusCode).toBe(201);
    expect(siteResponseSchema.parse(allowed.json()).site.autopilotMode).toBe('review');
  });
});

describe('updating a site', () => {
  async function freshSite(jar: CookieJar, slug: string): Promise<string> {
    const response = await mutate(jar, 'POST', sitesUrl(fixture.orgA, fixture.cA1), {
      baseUrl: `https://${slug}.example.test`,
    });

    expect(response.statusCode).toBe(201);

    return siteResponseSchema.parse(response.json()).site.id;
  }

  it('updates a reachable site and audits it exactly once', async () => {
    const jar = await signIn(fixture.admin.email);
    const siteId = await freshSite(jar, 'api-update');

    const response = await mutate(jar, 'PATCH', siteUrl(fixture.orgA, fixture.cA1, siteId), {
      baseUrl: 'https://api-update-2.example.test',
      timezone: 'Europe/London',
    });

    expect(response.statusCode).toBe(200);

    const site = siteResponseSchema.parse(response.json()).site;
    expect(site.baseUrl).toBe('https://api-update-2.example.test');
    expect(site.timezone).toBe('Europe/London');
    expect(site.autopilotMode).toBe('review');

    const rows = (await auditRows(fixture.orgA, fixture.admin.userId)).filter(
      (row) => row.targetId === siteId && row.action === 'site.updated',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.before).toMatchObject({ baseUrl: 'https://api-update.example.test' });
    expect(rows[0]?.after).toMatchObject({ baseUrl: 'https://api-update-2.example.test' });
  });

  it.each([
    { id: '018f9e1a-0000-7000-8000-0000000000ff' },
    { organizationId: '018f9e1a-0000-7000-8000-0000000000ff' },
    { clientId: '018f9e1a-0000-7000-8000-0000000000ff' },
    { createdAt: '2026-01-01T00:00:00.000Z' },
    { status: 'archived' },
    { cmsType: 'wordpress' },
    { autopilotMode: 'safe_autopilot' },
    { graduationPolicy: {} },
    { riskOverrides: {} },
    { crawlBudget: {} },
    { unknown: true },
    {},
  ])('refuses patch body %j', async (payload) => {
    const jar = await signIn(fixture.admin.email);

    const response = await mutate(
      jar,
      'PATCH',
      siteUrl(fixture.orgA, fixture.cA1, fixture.s3),
      payload,
    );

    expect(response.statusCode).toBe(400);
  });

  it('writes no audit row for a patch that changes nothing', async () => {
    const jar = await signIn(fixture.admin.email);
    const siteId = await freshSite(jar, 'api-noop');

    const before = (await auditRows(fixture.orgA, fixture.admin.userId)).filter(
      (row) => row.targetId === siteId,
    ).length;

    const response = await mutate(jar, 'PATCH', siteUrl(fixture.orgA, fixture.cA1, siteId), {
      baseUrl: 'https://api-noop.example.test/',
    });

    expect(response.statusCode).toBe(200);

    const after = (await auditRows(fixture.orgA, fixture.admin.userId)).filter(
      (row) => row.targetId === siteId,
    ).length;

    expect(after).toBe(before);
  });

  it('writes no audit row for a refused mutation', async () => {
    const scoped = await signIn(fixture.scopedAdmin.email);

    const before = (await auditRows(fixture.orgA, fixture.admin.userId)).filter(
      (row) => row.targetId === fixture.s1,
    ).length;

    expect(
      (
        await mutate(scoped, 'PATCH', siteUrl(fixture.orgA, fixture.cA1, fixture.s1), {
          timezone: 'Europe/London',
        })
      ).statusCode,
    ).toBe(404);

    const after = (await auditRows(fixture.orgA, fixture.admin.userId)).filter(
      (row) => row.targetId === fixture.s1,
    ).length;

    expect(after).toBe(before);
  });

  it('never changes the autopilot mode of the site it updates', async () => {
    const jar = await signIn(fixture.admin.email);
    const siteId = await freshSite(jar, 'api-autopilot-untouched');

    await mutate(jar, 'PATCH', siteUrl(fixture.orgA, fixture.cA1, siteId), {
      language: 'fr',
    });

    const settings = await withTenantTransaction(
      database.runtime.db,
      { organizationId: fixture.orgA, actor: { kind: 'user', userId: fixture.admin.userId } },
      async (repositories) => repositories.siteSettings.findBySiteId(siteId),
    );

    expect(settings?.autopilotMode).toBe('review');
  });
});

describe('pagination', () => {
  it('walks pages without repeats or gaps and stays inside the client', async () => {
    const jar = await signIn(fixture.admin.email);

    const everything = await listedIds(jar, fixture.orgA, fixture.cA1, '?limit=100');
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 50; page += 1) {
      const url: string =
        cursor === null
          ? `${sitesUrl(fixture.orgA, fixture.cA1)}?limit=2`
          : `${sitesUrl(fixture.orgA, fixture.cA1)}?limit=2&cursor=${encodeURIComponent(cursor)}`;

      const response = await get(jar, url);
      expect(response.statusCode).toBe(200);

      const body = siteListResponseSchema.parse(response.json());
      seen.push(...body.sites.map((site) => site.id));

      if (body.page.nextCursor === null) {
        break;
      }

      cursor = body.page.nextCursor;
    }

    expect(seen).toEqual(everything);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(fixture.s2a);
    expect(seen).not.toContain(fixture.sB1);
  });

  it('applies the default limit, accepts the maximum and refuses more', async () => {
    const jar = await signIn(fixture.admin.email);
    const base = sitesUrl(fixture.orgA, fixture.cA1);

    const defaulted = await get(jar, base);
    expect(siteListResponseSchema.parse(defaulted.json()).page.limit).toBe(50);

    const max = await get(jar, `${base}?limit=100`);
    expect(siteListResponseSchema.parse(max.json()).page.limit).toBe(100);

    expect((await get(jar, `${base}?limit=101`)).statusCode).toBe(400);
    expect((await get(jar, `${base}?limit=0`)).statusCode).toBe(400);
    expect((await get(jar, `${base}?page=2`)).statusCode).toBe(400);
    expect((await get(jar, `${base}?cursor=not-a-cursor`)).statusCode).toBe(400);
  });

  it('reports no total count', async () => {
    const jar = await signIn(fixture.admin.email);

    const response = await get(jar, sitesUrl(fixture.orgA, fixture.cA1));
    const page = response.json<{ page: Record<string, unknown> }>().page;

    expect(Object.keys(page).sort()).toEqual(['limit', 'nextCursor']);
  });
});

describe('the phase boundary', () => {
  it('serves no deletion, archive or site-settings route', async () => {
    const jar = await signIn(fixture.admin.email);
    const url = siteUrl(fixture.orgA, fixture.cA1, fixture.s1);

    for (const [method, target] of [
      ['DELETE', url],
      ['POST', `${url}/archive`],
      ['GET', `${url}/settings`],
      ['PATCH', `${url}/settings`],
      ['PATCH', `${url}/autopilot`],
    ] as const) {
      const response = await app.inject({
        method,
        url: target,
        headers: { ...jar.headersFor(config), 'content-type': 'application/json' },
        payload: {},
      });

      expect(response.statusCode).toBe(404);
    }
  });

  it('leaves the client API of sub-phase 0.4.2B1 working unchanged', async () => {
    const jar = await signIn(fixture.admin.email);

    const response = await get(jar, `/organizations/${fixture.orgA}/clients`);

    expect(response.statusCode).toBe(200);
    expect(logLines.length).toBeGreaterThan(0);
  });
});
