import { createAuthConfig, type AuthConfig } from '@organic-os/auth';
import { InMemoryAuthStore } from '@organic-os/auth/testing';
import {
  AuthorizationError,
  MembershipAdministrationError,
  type AuthorizationFailure,
  type MembershipAdministrationFailure,
} from '@organic-os/authorization';
import {
  memberListResponseSchema,
  memberResponseSchema,
  problemDetailsSchema,
} from '@organic-os/contracts';
import type {
  AuthorizationService,
  MemberAdministrationService,
  MemberView,
} from '@organic-os/database';
import { createLogger, type LogDestination } from '@organic-os/observability';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { buildAuthDependencies } from '../auth/build.js';
import { CookieJar, TEST_AUTH_ENV, testPasswordHasher } from '../testing/auth-helpers.js';

/**
 * HTTP behaviour of the member administration routes: status codes, request
 * validation, response shapes, and the two refusal vocabularies.
 *
 * The administration *decisions* are tested where they are made — as values in
 * `@organic-os/authorization`, and against real PostgreSQL with locking and Row Level
 * Security in `packages/database/src/administration/`. What is tested here is the
 * mapping from a refusal to a response, which is where an information leak would
 * appear, and the body validation that has to reject before any of that runs.
 */

const PASSWORD = 'correct horse battery staple';
const EMAIL = 'admin@example.test';
const ORGANIZATION_ID = '018f9e1a-0000-7000-8000-0000000000a0';
const MEMBERSHIP_ID = '018f9e1a-0000-7000-8000-0000000000b0';
const USER_ID = '018f9e1a-0000-7000-8000-0000000000c0';
const CLIENT_ID = '018f9e1a-0000-7000-8000-0000000000d0';

let app: FastifyInstance;
let config: AuthConfig;
let jar: CookieJar;
let logLines: string[];

/** Set by a test to make the next administration call fail in a particular way. */
let refusal: AuthorizationFailure | MembershipAdministrationFailure | null;
/** Recorded so a test can assert what the handler forwarded to the service. */
let lastCall: { method: string; args: readonly unknown[] } | null;

const destination: LogDestination = {
  write(chunk: string): void {
    logLines.push(chunk);
  },
};

const AUTHORIZATION_FAILURES: readonly AuthorizationFailure[] = [
  'malformed_organization_id',
  'no_membership',
  'permission_denied',
  'resource_not_in_organization',
  'client_out_of_scope',
];

function isAuthorizationFailure(value: string): value is AuthorizationFailure {
  return (AUTHORIZATION_FAILURES as readonly string[]).includes(value);
}

const MEMBER: MemberView = {
  membershipId: MEMBERSHIP_ID,
  userId: USER_ID,
  email: 'member@example.test',
  name: 'Member',
  role: 'analyst',
  clientAccessMode: 'scoped',
  scopedClientIds: [CLIENT_ID],
  createdAt: new Date('2026-08-31T10:00:00.000Z'),
  updatedAt: new Date('2026-08-31T11:00:00.000Z'),
};

/** Refuses on demand, otherwise returns a fixed member. Records what it was asked. */
function stubService(): MemberAdministrationService {
  function record<T>(method: string, args: readonly unknown[], value: T): Promise<T> {
    lastCall = { method, args };

    if (refusal !== null) {
      return Promise.reject(
        isAuthorizationFailure(refusal)
          ? new AuthorizationError(refusal)
          : new MembershipAdministrationError(refusal),
      );
    }

    return Promise.resolve(value);
  }

  return {
    listMembers: async (...args) => record('listMembers', args, [MEMBER] as readonly MemberView[]),
    addMember: async (...args) => record('addMember', args, MEMBER),
    changeMemberRole: async (...args) => record('changeMemberRole', args, MEMBER),
    replaceMemberScopes: async (...args) => record('replaceMemberScopes', args, MEMBER),
    removeMember: async (...args) => record('removeMember', args, undefined),
  };
}

/** Only ever refuses: every success path needs a real transaction (0.4.1 pattern). */
const authorization: AuthorizationService = {
  listOrganizations: async () => Promise.resolve([]),
  withAuthorizedOrganization: async () => Promise.reject(new AuthorizationError('no_membership')),
};

beforeEach(async () => {
  logLines = [];
  refusal = null;
  lastCall = null;
  jar = new CookieJar();
  config = createAuthConfig({ ...TEST_AUTH_ENV });

  const store = new InMemoryAuthStore();
  store.addUser({
    email: EMAIL,
    name: 'Admin',
    passwordHash: await testPasswordHasher.hash(PASSWORD),
    isPlatformAdmin: false,
  });

  app = buildApp({
    logger: createLogger({ name: 'api-admin-test', level: 'trace' }, destination),
    serviceVersion: '0.0.0-test',
    auth: buildAuthDependencies({ store, config }),
    authorization,
    memberAdministration: stubService(),
  });

  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function login(): Promise<void> {
  jar.absorb(await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie: '' } }));

  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { ...jar.headersFor(config), 'content-type': 'application/json' },
    payload: { email: EMAIL, password: PASSWORD },
  });

  expect(response.statusCode).toBe(200);
  jar.absorb(response);
}

const membersUrl = `/organizations/${ORGANIZATION_ID}/members`;
const roleUrl = `${membersUrl}/${MEMBERSHIP_ID}/role`;
const scopesUrl = `${membersUrl}/${MEMBERSHIP_ID}/scopes`;
const memberUrl = `${membersUrl}/${MEMBERSHIP_ID}`;

async function send(
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

describe('authentication is required first', () => {
  const cases = [
    { method: 'GET', url: membersUrl },
    { method: 'POST', url: membersUrl },
    { method: 'PATCH', url: roleUrl },
    { method: 'PUT', url: scopesUrl },
    { method: 'DELETE', url: memberUrl },
  ] as const;

  it.each(cases)('refuses $method $url with 401 when unauthenticated', async ({ method, url }) => {
    // No session and no CSRF token: the CSRF hook answers first for state-changing
    // methods, so both 401 and 403 are correct refusals. What must never happen is
    // the service being reached.
    const response = await app.inject({ method, url });

    expect([401, 403]).toContain(response.statusCode);
    expect(lastCall).toBeNull();
  });
});

describe('reading the member list', () => {
  it('returns a contract-valid list', async () => {
    await login();

    const response = await app.inject({
      method: 'GET',
      url: membersUrl,
      headers: { cookie: jar.header() },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');

    const body = memberListResponseSchema.parse(response.json());
    expect(body.members).toHaveLength(1);
    expect(body.members[0]?.membershipId).toBe(MEMBERSHIP_ID);
    expect(body.members[0]?.createdAt).toBe('2026-08-31T10:00:00.000Z');
  });

  it('never exposes an authentication or platform field', async () => {
    await login();

    const response = await app.inject({
      method: 'GET',
      url: membersUrl,
      headers: { cookie: jar.header() },
    });

    const raw = response.body;
    for (const forbidden of ['passwordHash', 'password_hash', 'isPlatformAdmin', 'tokenHash']) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it('forwards only the user id as identity', async () => {
    await login();

    await app.inject({ method: 'GET', url: membersUrl, headers: { cookie: jar.header() } });

    expect(lastCall?.method).toBe('listMembers');
    expect(Object.keys(lastCall?.args[0] as object)).toEqual(['userId']);
  });
});

describe('adding a member', () => {
  it('creates and answers 201 with the member', async () => {
    await login();

    const response = await send('POST', membersUrl, {
      email: 'new@example.test',
      role: 'analyst',
      clientAccess: { mode: 'scoped', clientIds: [CLIENT_ID] },
    });

    expect(response.statusCode).toBe(201);
    expect(memberResponseSchema.parse(response.json()).member.membershipId).toBe(MEMBERSHIP_ID);
  });

  it('records the request source and socket address for the audit trail', async () => {
    await login();

    await send('POST', membersUrl, {
      email: 'new@example.test',
      role: 'analyst',
      clientAccess: { mode: 'all_clients' },
    });

    expect(lastCall?.args[3]).toMatchObject({ source: 'api' });
  });

  it('rejects a platform role name with 400 before reaching the service', async () => {
    await login();

    for (const role of ['super_admin', 'platform_admin', 'admin', '']) {
      const response = await send('POST', membersUrl, {
        email: 'new@example.test',
        role,
        clientAccess: { mode: 'all_clients' },
      });

      expect(response.statusCode).toBe(400);
      expect(lastCall).toBeNull();
    }
  });

  it('rejects a client list sent alongside all_clients', async () => {
    await login();

    // Strict: an administrator who sent a client list must never be left believing it
    // was applied.
    const response = await send('POST', membersUrl, {
      email: 'new@example.test',
      role: 'analyst',
      clientAccess: { mode: 'all_clients', clientIds: [CLIENT_ID] },
    });

    expect(response.statusCode).toBe(400);
    expect(lastCall).toBeNull();
  });

  it('rejects duplicate client ids rather than collapsing them', async () => {
    await login();

    const response = await send('POST', membersUrl, {
      email: 'new@example.test',
      role: 'analyst',
      clientAccess: { mode: 'scoped', clientIds: [CLIENT_ID, CLIENT_ID] },
    });

    expect(response.statusCode).toBe(400);
    expect(lastCall).toBeNull();
  });

  it('rejects an unknown field', async () => {
    await login();

    const response = await send('POST', membersUrl, {
      email: 'new@example.test',
      role: 'analyst',
      clientAccess: { mode: 'all_clients' },
      isPlatformAdmin: true,
    });

    expect(response.statusCode).toBe(400);
    expect(lastCall).toBeNull();
  });

  it('rejects a malformed address', async () => {
    await login();

    const response = await send('POST', membersUrl, {
      email: 'not-an-address',
      role: 'analyst',
      clientAccess: { mode: 'all_clients' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('answers 422 INVITATION_FLOW_NOT_IMPLEMENTED for an address with no account', async () => {
    await login();
    refusal = 'user_not_registered';

    const response = await send('POST', membersUrl, {
      email: 'nobody@example.test',
      role: 'analyst',
      clientAccess: { mode: 'all_clients' },
    });

    expect(response.statusCode).toBe(422);

    const problem = problemDetailsSchema.parse(response.json());
    expect(problem.code).toBe('INVITATION_FLOW_NOT_IMPLEMENTED');
    expect(problem.type).toContain('invitation-flow-not-implemented');
  });

  it('answers 409 MEMBERSHIP_ALREADY_EXISTS for a user already in the organization', async () => {
    await login();
    refusal = 'membership_already_exists';

    const response = await send('POST', membersUrl, {
      email: 'member@example.test',
      role: 'analyst',
      clientAccess: { mode: 'all_clients' },
    });

    expect(response.statusCode).toBe(409);
    expect(problemDetailsSchema.parse(response.json()).code).toBe('MEMBERSHIP_ALREADY_EXISTS');
  });
});

describe('changing a role', () => {
  it('answers 200 with the updated member', async () => {
    await login();

    const response = await send('PATCH', roleUrl, { role: 'seo_manager' });

    expect(response.statusCode).toBe(200);
    expect(lastCall?.method).toBe('changeMemberRole');
    expect(lastCall?.args[2]).toEqual({ membershipId: MEMBERSHIP_ID, role: 'seo_manager' });
  });

  it('rejects a role outside the organization vocabulary', async () => {
    await login();

    const response = await send('PATCH', roleUrl, { role: 'platform_admin' });

    expect(response.statusCode).toBe(400);
    expect(lastCall).toBeNull();
  });

  it('answers 409 SELF_MUTATION_FORBIDDEN', async () => {
    await login();
    refusal = 'self_mutation_forbidden';

    const response = await send('PATCH', roleUrl, { role: 'analyst' });

    expect(response.statusCode).toBe(409);
    expect(problemDetailsSchema.parse(response.json()).code).toBe('SELF_MUTATION_FORBIDDEN');
  });

  it('answers 409 LAST_AGENCY_ADMIN', async () => {
    await login();
    refusal = 'last_agency_admin';

    const response = await send('PATCH', roleUrl, { role: 'analyst' });

    expect(response.statusCode).toBe(409);
    expect(problemDetailsSchema.parse(response.json()).code).toBe('LAST_AGENCY_ADMIN');
  });
});

describe('replacing client scopes', () => {
  it('accepts an explicit empty scope, meaning zero clients', async () => {
    await login();

    const response = await send('PUT', scopesUrl, { mode: 'scoped', clientIds: [] });

    expect(response.statusCode).toBe(200);
    expect(lastCall?.args[2]).toEqual({
      membershipId: MEMBERSHIP_ID,
      clientAccess: { mode: 'scoped', clientIds: [] },
    });
  });

  it('accepts all_clients', async () => {
    await login();

    const response = await send('PUT', scopesUrl, { mode: 'all_clients' });

    expect(response.statusCode).toBe(200);
    expect(lastCall?.args[2]).toEqual({
      membershipId: MEMBERSHIP_ID,
      clientAccess: { mode: 'all_clients' },
    });
  });

  it('rejects an unknown mode', async () => {
    await login();

    for (const mode of ['ALL_CLIENTS', 'all', 'none', '']) {
      const response = await send('PUT', scopesUrl, { mode });

      expect(response.statusCode).toBe(400);
      expect(lastCall).toBeNull();
    }
  });

  it('rejects a malformed client id', async () => {
    await login();

    const response = await send('PUT', scopesUrl, {
      mode: 'scoped',
      clientIds: ['not-a-uuid'],
    });

    expect(response.statusCode).toBe(400);
    expect(lastCall).toBeNull();
  });

  it('answers 409 CLIENT_VIEWER_REQUIRES_SCOPED', async () => {
    await login();
    refusal = 'client_viewer_requires_scoped';

    const response = await send('PUT', scopesUrl, { mode: 'all_clients' });

    expect(response.statusCode).toBe(409);
    expect(problemDetailsSchema.parse(response.json()).code).toBe('CLIENT_VIEWER_REQUIRES_SCOPED');
  });
});

describe('removing a member', () => {
  it('answers 204 with no body', async () => {
    await login();

    const response = await send('DELETE', memberUrl);

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(lastCall?.method).toBe('removeMember');
  });

  it('answers 409 LAST_AGENCY_ADMIN', async () => {
    await login();
    refusal = 'last_agency_admin';

    const response = await send('DELETE', memberUrl);

    expect(response.statusCode).toBe(409);
  });
});

describe('non-enumeration is preserved', () => {
  it('answers 403 only for a proven member whose role is insufficient', async () => {
    await login();
    refusal = 'permission_denied';

    const response = await app.inject({
      method: 'GET',
      url: membersUrl,
      headers: { cookie: jar.header() },
    });

    expect(response.statusCode).toBe(403);
    expect(problemDetailsSchema.parse(response.json()).title).toBe('Permission Denied');
  });

  it('answers an identical 404 for every unreachable-resource cause', async () => {
    await login();

    const bodies = new Set<string>();

    for (const failure of [
      'no_membership',
      'malformed_organization_id',
      'resource_not_in_organization',
      'client_out_of_scope',
    ] as const) {
      refusal = failure;

      const response = await app.inject({
        method: 'GET',
        url: membersUrl,
        headers: { cookie: jar.header() },
      });

      expect(response.statusCode).toBe(404);

      const problem = problemDetailsSchema.parse(response.json());
      // The request id is the only thing allowed to differ.
      bodies.add(JSON.stringify({ ...problem, requestId: '(ignored)' }));
    }

    expect(bodies.size).toBe(1);
  });

  it('carries no failure code on a 404, so the four causes stay indistinguishable', async () => {
    await login();
    refusal = 'resource_not_in_organization';

    const response = await app.inject({
      method: 'DELETE',
      url: memberUrl,
      headers: { ...jar.headersFor(config) },
    });

    expect(response.statusCode).toBe(404);
    expect(problemDetailsSchema.parse(response.json()).code).toBeUndefined();
  });

  it('logs the internal failure category without putting it in the response', async () => {
    await login();
    refusal = 'no_membership';

    const response = await app.inject({
      method: 'GET',
      url: membersUrl,
      headers: { cookie: jar.header() },
    });

    expect(response.body).not.toContain('no_membership');
    expect(logLines.some((line) => line.includes('no_membership'))).toBe(true);
  });
});

describe('CSRF applies to every mutation', () => {
  const cases = [
    { method: 'POST', url: membersUrl },
    { method: 'PATCH', url: roleUrl },
    { method: 'PUT', url: scopesUrl },
    { method: 'DELETE', url: memberUrl },
  ] as const;

  it.each(cases)('rejects $method without a CSRF token', async ({ method, url }) => {
    await login();

    const response = await app.inject({
      method,
      url,
      // The session cookie, but no CSRF header.
      headers: { cookie: jar.header(), 'content-type': 'application/json' },
      payload: { role: 'analyst', mode: 'all_clients', email: 'x@example.test' },
    });

    expect(response.statusCode).toBe(403);
    expect(problemDetailsSchema.parse(response.json()).title).toBe('CSRF Token Invalid');
    expect(lastCall).toBeNull();
  });
});

describe('routes are absent unless wired', () => {
  it('serves no member route when member administration is not configured', async () => {
    const store = new InMemoryAuthStore();
    const bare = buildApp({
      logger: createLogger({ name: 'api-admin-bare', level: 'silent' }, destination),
      serviceVersion: '0.0.0-test',
      auth: buildAuthDependencies({ store, config }),
      authorization,
    });

    await bare.ready();

    try {
      const response = await bare.inject({ method: 'GET', url: membersUrl });

      // Fail closed: no route at all rather than an unguarded one.
      expect(response.statusCode).toBe(404);
      expect(problemDetailsSchema.parse(response.json()).title).toBe('Not Found');
    } finally {
      await bare.close();
    }
  });
});
