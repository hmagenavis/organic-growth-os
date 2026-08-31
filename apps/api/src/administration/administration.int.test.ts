import { createAuthConfig, type AuthConfig } from '@organic-os/auth';
import {
  createAuthorizationService,
  createAuthStore,
  createMemberAdministrationService,
  createMembershipStore,
  provisionMembership,
  provisionOrganization,
  provisionUser,
  withTenantTransaction,
  type TenantContext,
} from '@organic-os/database';
import { createTestDatabase, type TestDatabase } from '@organic-os/database/testing';
import {
  memberListResponseSchema,
  memberResponseSchema,
  problemDetailsSchema,
} from '@organic-os/contracts';
import { createLogger, type LogDestination } from '@organic-os/observability';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { buildApp } from '../app.js';
import { buildAuthDependencies } from '../auth/build.js';
import { CookieJar, TEST_AUTH_ENV, testPasswordHasher } from '../testing/auth-helpers.js';

/**
 * Member administration over HTTP, against real PostgreSQL.
 *
 * The database suite proves what the transaction does. This proves what a browser
 * sees: that an administrator can drive the whole flow with cookies and CSRF tokens,
 * that a member whose role changed is *actually logged out* on their next request,
 * and that every unreachable resource answers with the same bytes whether it belongs
 * to another tenant, does not exist, or was never a valid identifier.
 */

const PASSWORD = 'correct horse battery staple';

let database: TestDatabase;
let app: FastifyInstance;
let config: AuthConfig;
let logLines: string[];

interface Fixture {
  orgA: string;
  orgB: string;
  clientA1: string;
  clientA2: string;
  clientB1: string;
  adminEmail: string;
  adminMembershipId: string;
  secondAdminEmail: string;
  managerEmail: string;
  managerMembershipId: string;
  viewerEmail: string;
  viewerMembershipId: string;
  foreignEmail: string;
  foreignMembershipId: string;
  unattachedEmail: string;
}

let fixture: Fixture;

const destination: LogDestination = {
  write(chunk: string): void {
    logLines.push(chunk);
  },
};

beforeAll(async () => {
  logLines = [];
  database = await createTestDatabase(inject('postgresAdminUri'), 'organic_os_api_member_test');

  const provisioner = database.provisioner.db;
  const passwordHash = await testPasswordHasher.hash(PASSWORD);

  const organizationA = await provisionOrganization(provisioner, {
    name: 'Api Member A',
    slug: 'api-member-a',
  });
  const organizationB = await provisionOrganization(provisioner, {
    name: 'Api Member B',
    slug: 'api-member-b',
  });

  async function member(
    organizationId: string | null,
    handle: string,
    role: 'agency_admin' | 'seo_manager' | 'client_viewer',
    clientAccessMode: 'all_clients' | 'scoped',
  ): Promise<{ email: string; userId: string; membershipId: string }> {
    const user = await provisionUser(provisioner, {
      email: `${handle}@example.test`,
      name: handle,
      passwordHash,
    });

    if (organizationId === null) {
      return { email: user.email, userId: user.id, membershipId: '' };
    }

    const membership = await provisionMembership(provisioner, {
      organizationId,
      userId: user.id,
      role,
      clientAccessMode,
    });

    return { email: user.email, userId: user.id, membershipId: membership.id };
  }

  const admin = await member(organizationA.id, 'api-member-admin', 'agency_admin', 'all_clients');
  const secondAdmin = await member(
    organizationA.id,
    'api-member-admin2',
    'agency_admin',
    'all_clients',
  );
  const manager = await member(
    organizationA.id,
    'api-member-manager',
    'seo_manager',
    'all_clients',
  );
  const viewer = await member(organizationA.id, 'api-member-viewer', 'client_viewer', 'scoped');
  const foreign = await member(
    organizationB.id,
    'api-member-foreign',
    'agency_admin',
    'all_clients',
  );
  const unattached = await member(null, 'api-member-unattached', 'seo_manager', 'all_clients');

  const tenantA: TenantContext = {
    organizationId: organizationA.id,
    actor: { kind: 'user', userId: admin.userId },
  };
  const tenantB: TenantContext = {
    organizationId: organizationB.id,
    actor: { kind: 'user', userId: foreign.userId },
  };

  const { clientA1, clientA2 } = await withTenantTransaction(
    database.runtime.db,
    tenantA,
    async (r) => {
      const first = await r.clients.create({ name: 'API Client A1' });
      const second = await r.clients.create({ name: 'API Client A2' });
      await r.membershipClientScopes.add({
        membershipId: viewer.membershipId,
        clientId: first.id,
      });
      return { clientA1: first.id, clientA2: second.id };
    },
  );

  const clientB1 = await withTenantTransaction(
    database.runtime.db,
    tenantB,
    async (r) => (await r.clients.create({ name: 'API Client B1' })).id,
  );

  config = createAuthConfig({ ...TEST_AUTH_ENV, AUTH_LOGIN_RATE_LIMIT_ACCOUNT_MAX: '80' });

  const authorization = createAuthorizationService({
    db: database.runtime.db,
    store: createMembershipStore(database.runtime.db),
  });

  app = buildApp({
    logger: createLogger({ name: 'api-member-int', level: 'trace' }, destination),
    serviceVersion: '0.0.0-test',
    auth: buildAuthDependencies({ store: createAuthStore(database.runtime.db), config }),
    authorization,
    memberAdministration: createMemberAdministrationService({
      authorization,
      db: database.runtime.db,
    }),
  });

  await app.ready();

  fixture = {
    orgA: organizationA.id,
    orgB: organizationB.id,
    clientA1,
    clientA2,
    clientB1,
    adminEmail: admin.email,
    adminMembershipId: admin.membershipId,
    secondAdminEmail: secondAdmin.email,
    managerEmail: manager.email,
    managerMembershipId: manager.membershipId,
    viewerEmail: viewer.email,
    viewerMembershipId: viewer.membershipId,
    foreignEmail: foreign.email,
    foreignMembershipId: foreign.membershipId,
    unattachedEmail: unattached.email,
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
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
): Promise<LightMyRequestResponse> {
  // No `content-type` without a body: a DELETE that announces JSON and sends none is
  // a malformed request, and Fastify is right to answer 400 rather than route it.
  if (payload === undefined) {
    return app.inject({ method, url, headers: { ...jar.headersFor(config) } });
  }

  return app.inject({
    method,
    url,
    headers: { ...jar.headersFor(config), 'content-type': 'application/json' },
    payload,
  });
}

function membersUrl(organizationId: string): string {
  return `/organizations/${organizationId}/members`;
}

describe('the administrator drives the whole workflow', () => {
  it('lists, attaches, re-roles, re-scopes and removes', async () => {
    const admin = await signIn(fixture.adminEmail);

    const listed = await get(admin, membersUrl(fixture.orgA));
    expect(listed.statusCode).toBe(200);
    expect(memberListResponseSchema.parse(listed.json()).members).toHaveLength(4);

    const created = await mutate(admin, 'POST', membersUrl(fixture.orgA), {
      email: fixture.unattachedEmail,
      role: 'analyst',
      clientAccess: { mode: 'scoped', clientIds: [fixture.clientA1] },
    });

    expect(created.statusCode).toBe(201);
    const member = memberResponseSchema.parse(created.json()).member;
    expect(member.role).toBe('analyst');
    expect(member.scopedClientIds).toEqual([fixture.clientA1]);

    const rerole = await mutate(
      admin,
      'PATCH',
      `${membersUrl(fixture.orgA)}/${member.membershipId}/role`,
      { role: 'content_editor' },
    );
    expect(rerole.statusCode).toBe(200);
    expect(memberResponseSchema.parse(rerole.json()).member.role).toBe('content_editor');

    const rescope = await mutate(
      admin,
      'PUT',
      `${membersUrl(fixture.orgA)}/${member.membershipId}/scopes`,
      { mode: 'scoped', clientIds: [fixture.clientA1, fixture.clientA2] },
    );
    expect(rescope.statusCode).toBe(200);
    expect([...memberResponseSchema.parse(rescope.json()).member.scopedClientIds].sort()).toEqual(
      [fixture.clientA1, fixture.clientA2].sort(),
    );

    const removed = await mutate(
      admin,
      'DELETE',
      `${membersUrl(fixture.orgA)}/${member.membershipId}`,
    );
    expect(removed.statusCode).toBe(204);

    const after = await get(admin, membersUrl(fixture.orgA));
    expect(memberListResponseSchema.parse(after.json()).members).toHaveLength(4);
  });
});

describe('a security-sensitive change ends the affected member sessions', () => {
  it('logs the member out of every browser, and nobody else', async () => {
    // Two browsers for the member, one for an uninvolved colleague.
    const memberOne = await signIn(fixture.managerEmail);
    const memberTwo = await signIn(fixture.managerEmail);
    const bystander = await signIn(fixture.viewerEmail);

    expect((await get(memberOne, '/auth/me')).statusCode).toBe(200);
    expect((await get(memberTwo, '/auth/me')).statusCode).toBe(200);

    const admin = await signIn(fixture.adminEmail);

    const changed = await mutate(
      admin,
      'PATCH',
      `${membersUrl(fixture.orgA)}/${fixture.managerMembershipId}/role`,
      { role: 'analyst' },
    );
    expect(changed.statusCode).toBe(200);

    // Both of the member's sessions are gone, server-side, immediately.
    expect((await get(memberOne, '/auth/me')).statusCode).toBe(401);
    expect((await get(memberTwo, '/auth/me')).statusCode).toBe(401);

    // The uninvolved colleague is untouched, and so is the administrator.
    expect((await get(bystander, '/auth/me')).statusCode).toBe(200);
    expect((await get(admin, '/auth/me')).statusCode).toBe(200);
  });

  it('does not end sessions when client access broadens', async () => {
    const viewer = await signIn(fixture.viewerEmail);
    const admin = await signIn(fixture.adminEmail);

    const broadened = await mutate(
      admin,
      'PUT',
      `${membersUrl(fixture.orgA)}/${fixture.viewerMembershipId}/scopes`,
      { mode: 'scoped', clientIds: [fixture.clientA1, fixture.clientA2] },
    );
    expect(broadened.statusCode).toBe(200);

    // Documented policy: nothing that was permitted stopped being permitted, and
    // authorization is re-read per request anyway.
    expect((await get(viewer, '/auth/me')).statusCode).toBe(200);

    const narrowed = await mutate(
      admin,
      'PUT',
      `${membersUrl(fixture.orgA)}/${fixture.viewerMembershipId}/scopes`,
      { mode: 'scoped', clientIds: [fixture.clientA1] },
    );
    expect(narrowed.statusCode).toBe(200);

    expect((await get(viewer, '/auth/me')).statusCode).toBe(401);
  });

  it('ends the removed member sessions and stops authorizing the organization', async () => {
    const admin = await signIn(fixture.adminEmail);

    const created = await mutate(admin, 'POST', membersUrl(fixture.orgA), {
      email: fixture.unattachedEmail,
      role: 'analyst',
      clientAccess: { mode: 'all_clients' },
    });
    const member = memberResponseSchema.parse(created.json()).member;

    const memberJar = await signIn(fixture.unattachedEmail);
    expect((await get(memberJar, `/organizations/${fixture.orgA}`)).statusCode).toBe(200);

    const removed = await mutate(
      admin,
      'DELETE',
      `${membersUrl(fixture.orgA)}/${member.membershipId}`,
    );
    expect(removed.statusCode).toBe(204);

    expect((await get(memberJar, '/auth/me')).statusCode).toBe(401);
  });
});

describe('only an agency admin may administer', () => {
  it('answers 403 to a proven member whose role is insufficient', async () => {
    const viewer = await signIn(fixture.viewerEmail);

    const response = await get(viewer, membersUrl(fixture.orgA));

    expect(response.statusCode).toBe(403);
    expect(problemDetailsSchema.parse(response.json()).title).toBe('Permission Denied');
  });

  it('answers 403 for every mutation attempted by a non-admin', async () => {
    const viewer = await signIn(fixture.viewerEmail);

    const attempts = [
      await mutate(viewer, 'POST', membersUrl(fixture.orgA), {
        email: fixture.unattachedEmail,
        role: 'agency_admin',
        clientAccess: { mode: 'all_clients' },
      }),
      await mutate(
        viewer,
        'PATCH',
        `${membersUrl(fixture.orgA)}/${fixture.managerMembershipId}/role`,
        { role: 'agency_admin' },
      ),
      await mutate(
        viewer,
        'PUT',
        `${membersUrl(fixture.orgA)}/${fixture.managerMembershipId}/scopes`,
        { mode: 'all_clients' },
      ),
      await mutate(viewer, 'DELETE', `${membersUrl(fixture.orgA)}/${fixture.managerMembershipId}`),
    ];

    for (const response of attempts) {
      expect(response.statusCode).toBe(403);
    }
  });
});

describe('cross-tenant identifiers reveal nothing', () => {
  it('answers an identical 404 for every unreachable target', async () => {
    const admin = await signIn(fixture.adminEmail);

    const urls = [
      // Another organization entirely.
      membersUrl(fixture.orgB),
      // An organization id that is well formed and belongs to nobody.
      membersUrl('00000000-0000-4000-8000-000000000000'),
      // Not an identifier at all.
      membersUrl('not-a-uuid'),
    ];

    const bodies = new Set<string>();

    for (const url of urls) {
      const response = await get(admin, url);

      expect(response.statusCode).toBe(404);

      const problem = problemDetailsSchema.parse(response.json());
      expect(problem.code).toBeUndefined();
      bodies.add(JSON.stringify({ ...problem, requestId: '(ignored)', instance: '(ignored)' }));
    }

    expect(bodies.size).toBe(1);
  });

  it('answers 404 for another tenant membership id, and changes nothing', async () => {
    const admin = await signIn(fixture.adminEmail);

    for (const [method, url, payload] of [
      [
        'PATCH',
        `${membersUrl(fixture.orgA)}/${fixture.foreignMembershipId}/role`,
        { role: 'analyst' },
      ],
      [
        'PUT',
        `${membersUrl(fixture.orgA)}/${fixture.foreignMembershipId}/scopes`,
        { mode: 'all_clients' },
      ],
      ['DELETE', `${membersUrl(fixture.orgA)}/${fixture.foreignMembershipId}`, undefined],
    ] as const) {
      const response = await mutate(admin, method, url, payload);

      expect(response.statusCode).toBe(404);
    }

    // The foreign administrator is untouched and can still administer their own.
    const foreign = await signIn(fixture.foreignEmail);
    const listed = await get(foreign, membersUrl(fixture.orgB));

    expect(listed.statusCode).toBe(200);
    expect(memberListResponseSchema.parse(listed.json()).members).toHaveLength(1);
  });

  it('answers 404 for a client of another organization in a scope request', async () => {
    const admin = await signIn(fixture.adminEmail);

    const response = await mutate(
      admin,
      'PUT',
      `${membersUrl(fixture.orgA)}/${fixture.viewerMembershipId}/scopes`,
      { mode: 'scoped', clientIds: [fixture.clientB1] },
    );

    expect(response.statusCode).toBe(404);
    expect(problemDetailsSchema.parse(response.json()).code).toBeUndefined();
  });
});

describe('self-mutation is refused over HTTP too', () => {
  it('refuses a self role change, scope change and removal', async () => {
    const admin = await signIn(fixture.adminEmail);

    const roleChange = await mutate(
      admin,
      'PATCH',
      `${membersUrl(fixture.orgA)}/${fixture.adminMembershipId}/role`,
      { role: 'analyst' },
    );
    expect(roleChange.statusCode).toBe(409);
    expect(problemDetailsSchema.parse(roleChange.json()).code).toBe('SELF_MUTATION_FORBIDDEN');

    const scopeChange = await mutate(
      admin,
      'PUT',
      `${membersUrl(fixture.orgA)}/${fixture.adminMembershipId}/scopes`,
      { mode: 'scoped', clientIds: [] },
    );
    expect(scopeChange.statusCode).toBe(409);

    const removal = await mutate(
      admin,
      'DELETE',
      `${membersUrl(fixture.orgA)}/${fixture.adminMembershipId}`,
    );
    expect(removal.statusCode).toBe(409);

    // Still an administrator, still signed in.
    expect((await get(admin, membersUrl(fixture.orgA))).statusCode).toBe(200);
  });
});

describe('the invitation workflow does not exist yet', () => {
  it('says so, rather than creating an account with a password nobody chose', async () => {
    const admin = await signIn(fixture.adminEmail);

    const response = await mutate(admin, 'POST', membersUrl(fixture.orgA), {
      email: 'never-registered@example.test',
      role: 'analyst',
      clientAccess: { mode: 'all_clients' },
    });

    expect(response.statusCode).toBe(422);
    expect(problemDetailsSchema.parse(response.json()).code).toBe(
      'INVITATION_FLOW_NOT_IMPLEMENTED',
    );

    const listed = await get(admin, membersUrl(fixture.orgA));
    expect(
      memberListResponseSchema
        .parse(listed.json())
        .members.some((row) => row.email === 'never-registered@example.test'),
    ).toBe(false);
  });
});

describe('nothing secret reaches a response or a log line', () => {
  it('keeps credentials, hashes and platform flags out of every body', async () => {
    const admin = await signIn(fixture.adminEmail);
    const listed = await get(admin, membersUrl(fixture.orgA));

    for (const forbidden of [
      'password',
      'passwordHash',
      'password_hash',
      'argon2',
      'tokenHash',
      'isPlatformAdmin',
    ]) {
      expect(listed.body.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('keeps session tokens and CSRF tokens out of the logs', () => {
    const joined = logLines.join('\n').toLowerCase();

    expect(joined).not.toContain(PASSWORD.toLowerCase());
    expect(joined).not.toContain('set-cookie');
    expect(joined).not.toContain('csrftoken');
  });
});
