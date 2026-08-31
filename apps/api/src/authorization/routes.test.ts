import { createAuthConfig, type AuthConfig } from '@organic-os/auth';
import { InMemoryAuthStore } from '@organic-os/auth/testing';
import {
  AuthorizationError,
  type AuthenticatedIdentityRef,
  type AuthorizationFailure,
  type MembershipSummary,
} from '@organic-os/authorization';
import { organizationListResponseSchema, problemDetailsSchema } from '@organic-os/contracts';
import type { AuthorizationService } from '@organic-os/database';
import { createLogger, type LogDestination } from '@organic-os/observability';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { CookieJar, TEST_AUTH_ENV, testPasswordHasher } from '../testing/auth-helpers.js';
import { buildAuthDependencies } from '../auth/build.js';

/**
 * HTTP behaviour of the authorization routes: status codes, response shapes and the
 * non-enumeration policy.
 *
 * The authorization *decisions* are tested where they are made — in
 * `@organic-os/authorization` and against real PostgreSQL in
 * `packages/database/src/authorization/`. What is tested here is the mapping from a
 * refusal to a response, which is where an information leak would appear.
 */

const PASSWORD = 'correct horse battery staple';
const EMAIL = 'member@example.test';
const ORGANIZATION_ID = '018f9e1a-0000-7000-8000-0000000000a0';

let app: FastifyInstance;
let config: AuthConfig;
let jar: CookieJar;
let logLines: string[];
let memberships: MembershipSummary[];
/** Set by a test to make the next organization read fail in a particular way. */
let refusal: AuthorizationFailure | null;

const destination: LogDestination = {
  write(chunk: string): void {
    logLines.push(chunk);
  },
};

/**
 * A stand-in for the real service that can only refuse.
 *
 * Deliberately never invokes the callback: every success path needs real
 * repositories, real Row Level Security and a real transaction, so it is tested in
 * the integration suite rather than modelled here.
 */
const service: AuthorizationService = {
  listOrganizations: async (identity: AuthenticatedIdentityRef) => {
    expect(identity.userId).toMatch(/^[0-9a-f-]{36}$/);
    return Promise.resolve(memberships);
  },
  withAuthorizedOrganization: async () => {
    return Promise.reject(new AuthorizationError(refusal ?? 'no_membership'));
  },
};

beforeEach(async () => {
  logLines = [];
  memberships = [];
  refusal = null;
  jar = new CookieJar();
  config = createAuthConfig({ ...TEST_AUTH_ENV });

  const store = new InMemoryAuthStore();
  store.addUser({
    email: EMAIL,
    name: 'Member',
    passwordHash: await testPasswordHasher.hash(PASSWORD),
    isPlatformAdmin: false,
  });

  app = buildApp({
    logger: createLogger({ name: 'api-test', level: 'trace' }, destination),
    serviceVersion: '0.0.0-test',
    auth: buildAuthDependencies({ store, config }),
    authorization: service,
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

describe('authentication is required first', () => {
  it('refuses the organization list with 401 when unauthenticated', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/organizations' });

    expect(response.statusCode).toBe(401);
    expect(problemDetailsSchema.parse(response.json()).title).toBe('Authentication Required');
  });

  it('refuses an organization read with 401 when unauthenticated', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/organizations/${ORGANIZATION_ID}`,
    });

    expect(response.statusCode).toBe(401);
  });

  it('does not leak whether the organization exists to an unauthenticated caller', async () => {
    const real = await app.inject({ method: 'GET', url: `/organizations/${ORGANIZATION_ID}` });
    const fake = await app.inject({
      method: 'GET',
      url: '/organizations/00000000-0000-4000-8000-000000000000',
    });

    expect(real.statusCode).toBe(fake.statusCode);
  });
});

describe('organization listing', () => {
  it('returns an empty list for a user in no organization', async () => {
    await login();

    const response = await app.inject({
      method: 'GET',
      url: '/auth/organizations',
      headers: { cookie: jar.header() },
    });

    expect(response.statusCode).toBe(200);
    expect(organizationListResponseSchema.parse(response.json())).toEqual({ organizations: [] });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('reports role and client access mode for each organization', async () => {
    memberships = [
      {
        membershipId: '018f9e1a-0000-7000-8000-0000000000a2',
        organizationId: ORGANIZATION_ID,
        organizationName: 'Alpha',
        organizationSlug: 'alpha',
        role: 'client_viewer',
        clientAccessMode: 'scoped',
      },
    ];

    await login();

    const response = await app.inject({
      method: 'GET',
      url: '/auth/organizations',
      headers: { cookie: jar.header() },
    });

    const body = organizationListResponseSchema.parse(response.json());
    expect(body.organizations).toHaveLength(1);
    expect(body.organizations[0]?.role).toBe('client_viewer');
    expect(body.organizations[0]?.clientAccessMode).toBe('scoped');
  });

  it('drops a row whose role this build does not recognise', async () => {
    memberships = [
      {
        membershipId: '018f9e1a-0000-7000-8000-0000000000a2',
        organizationId: ORGANIZATION_ID,
        organizationName: 'Alpha',
        organizationSlug: 'alpha',
        role: 'super_admin',
        clientAccessMode: 'all_clients',
      },
    ];

    await login();

    const response = await app.inject({
      method: 'GET',
      url: '/auth/organizations',
      headers: { cookie: jar.header() },
    });

    expect(organizationListResponseSchema.parse(response.json()).organizations).toEqual([]);
    expect(logLines.join('\n')).toContain('unrecognised role');
  });
});

describe('the non-enumeration policy', () => {
  const notFound: AuthorizationFailure[] = [
    'no_membership',
    'malformed_organization_id',
    'resource_not_in_organization',
    'client_out_of_scope',
  ];

  it.each(notFound)('answers %s with an identical 404', async (failure) => {
    refusal = failure;
    await login();

    const response = await app.inject({
      method: 'GET',
      url: `/organizations/${ORGANIZATION_ID}`,
      headers: { cookie: jar.header() },
    });

    expect(response.statusCode).toBe(404);

    const problem = problemDetailsSchema.parse(response.json());
    expect(problem.title).toBe('Not Found');
    expect(problem.detail).toBe('The requested resource does not exist or is not available.');
  });

  it('answers a role refusal with 403 and names no permission', async () => {
    refusal = 'permission_denied';
    await login();

    const response = await app.inject({
      method: 'GET',
      url: `/organizations/${ORGANIZATION_ID}`,
      headers: { cookie: jar.header() },
    });

    expect(response.statusCode).toBe(403);

    const problem = problemDetailsSchema.parse(response.json());
    expect(problem.title).toBe('Permission Denied');
    expect(problem.detail).not.toContain('organization.read');
  });

  it('produces byte-identical bodies for every 404 cause, apart from the request id', async () => {
    await login();

    const bodies = new Set<string>();

    for (const failure of notFound) {
      refusal = failure;
      const response = await app.inject({
        method: 'GET',
        url: `/organizations/${ORGANIZATION_ID}`,
        headers: { cookie: jar.header() },
      });

      const problem = problemDetailsSchema.parse(response.json());
      bodies.add(JSON.stringify({ ...problem, requestId: undefined }));
    }

    expect(bodies.size).toBe(1);
  });

  it('logs the internal failure category without putting it in the response', async () => {
    refusal = 'client_out_of_scope';
    await login();

    const response = await app.inject({
      method: 'GET',
      url: `/organizations/${ORGANIZATION_ID}`,
      headers: { cookie: jar.header() },
    });

    expect(logLines.join('\n')).toContain('client_out_of_scope');
    expect(response.body).not.toContain('client_out_of_scope');
  });
});

describe('routes are absent without authentication wiring', () => {
  it('does not register authorization routes when auth is not configured', async () => {
    const bare = buildApp({
      logger: createLogger({ name: 'api-test', level: 'silent' }, destination),
      serviceVersion: '0.0.0-test',
      authorization: service,
    });

    await bare.ready();

    try {
      const response = await bare.inject({ method: 'GET', url: '/auth/organizations' });
      expect(response.statusCode).toBe(404);
    } finally {
      await bare.close();
    }
  });
});
