import { createAuthConfig, type AuthConfig } from '@organic-os/auth';
import { InMemoryAuthStore } from '@organic-os/auth/testing';
import { AuthorizationError, type AuthorizationFailure } from '@organic-os/authorization';
import {
  problemDetailsSchema,
  siteListResponseSchema,
  siteResponseSchema,
} from '@organic-os/contracts';
import {
  InvalidSiteCursorError,
  SiteBaseUrlConflictError,
  SiteInputError,
  type AuthorizationService,
  type SiteService,
  type SiteView,
} from '@organic-os/database';
import { createLogger, type LogDestination } from '@organic-os/observability';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { buildAuthDependencies } from '../auth/build.js';
import { CookieJar, TEST_AUTH_ENV, testPasswordHasher } from '../testing/auth-helpers.js';

/**
 * HTTP behaviour of the site routes: status codes, request validation, response
 * shapes, and the refusal mapping.
 *
 * The authorization *decisions* are tested where they are made — against real
 * PostgreSQL, with Row Level Security, real client scope rows and a real parent client
 * — in `sites.int.test.ts`. What is tested here is the mapping from a refusal to a
 * response, which is where an information leak would appear, and the input validation
 * that has to reject before any of that runs.
 */

const PASSWORD = 'correct horse battery staple';
const EMAIL = 'site-routes@example.test';
const ORGANIZATION_ID = '018f9e1a-0000-7000-8000-0000000000a0';
const CLIENT_ID = '018f9e1a-0000-7000-8000-0000000000d0';
const SITE_ID = '018f9e1a-0000-7000-8000-0000000000e0';

let app: FastifyInstance;
let config: AuthConfig;
let jar: CookieJar;
let logLines: string[];

/** Set by a test to make the next site call fail in a particular way. */
let refusal: AuthorizationFailure | 'invalid_cursor' | 'invalid_input' | 'conflict' | null;
/** Recorded so a test can assert what the handler forwarded to the service. */
let lastCall: { method: string; args: readonly unknown[] } | null;

const destination: LogDestination = {
  write(chunk: string): void {
    logLines.push(chunk);
  },
};

const SITE: SiteView = {
  id: SITE_ID,
  baseUrl: 'https://example.test',
  cmsType: 'wordpress',
  status: 'active',
  timezone: 'UTC',
  language: 'en',
  autopilotMode: 'review',
  createdAt: new Date('2026-08-31T10:00:00.000Z'),
  updatedAt: new Date('2026-08-31T11:00:00.000Z'),
};

/** Refuses on demand, otherwise returns a fixed site. Records what it was asked. */
function stubService(): SiteService {
  function record<T>(method: string, args: readonly unknown[], value: T): Promise<T> {
    lastCall = { method, args };

    if (refusal === 'invalid_cursor') {
      return Promise.reject(new InvalidSiteCursorError());
    }

    if (refusal === 'invalid_input') {
      return Promise.reject(new SiteInputError('baseUrl', 'unsupported_scheme'));
    }

    if (refusal === 'conflict') {
      return Promise.reject(new SiteBaseUrlConflictError());
    }

    if (refusal !== null) {
      return Promise.reject(new AuthorizationError(refusal));
    }

    return Promise.resolve(value);
  }

  return {
    listSites: async (...args) =>
      record('listSites', args, {
        sites: [SITE] as readonly SiteView[],
        limit: 50,
        nextCursor: null,
      }),
    getSite: async (...args) => record('getSite', args, SITE),
    createSite: async (...args) => record('createSite', args, SITE),
    updateSite: async (...args) => record('updateSite', args, SITE),
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
    name: 'Caller',
    passwordHash: await testPasswordHasher.hash(PASSWORD),
    isPlatformAdmin: false,
  });

  app = buildApp({
    logger: createLogger({ name: 'api-sites-test', level: 'trace' }, destination),
    serviceVersion: '0.0.0-test',
    auth: buildAuthDependencies({ store, config }),
    authorization,
    sites: stubService(),
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

const sitesUrl = `/organizations/${ORGANIZATION_ID}/clients/${CLIENT_ID}/sites`;
const siteUrl = `${sitesUrl}/${SITE_ID}`;

async function get(url: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url, headers: { cookie: jar.header() } });
}

async function send(
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

describe('authentication is required first', () => {
  const cases = [
    { method: 'GET', url: sitesUrl },
    { method: 'GET', url: siteUrl },
    { method: 'POST', url: sitesUrl },
    { method: 'PATCH', url: siteUrl },
  ] as const;

  it.each(cases)('refuses $method $url when unauthenticated', async ({ method, url }) => {
    // No session and no CSRF token: the CSRF hook answers first for state-changing
    // methods, so both 401 and 403 are correct refusals. What must never happen is
    // the service being reached.
    const response = await app.inject({ method, url });

    expect([401, 403]).toContain(response.statusCode);
    expect(lastCall).toBeNull();
  });
});

describe('the routes exist only when the site service is wired', () => {
  it('serves no site route at all without it', async () => {
    const bare = buildApp({
      logger: createLogger({ name: 'api-sites-bare', level: 'silent' }, destination),
      serviceVersion: '0.0.0-test',
      auth: buildAuthDependencies({ store: new InMemoryAuthStore(), config }),
      authorization,
    });

    await bare.ready();

    expect((await bare.inject({ method: 'GET', url: sitesUrl })).statusCode).toBe(404);
    expect((await bare.inject({ method: 'GET', url: siteUrl })).statusCode).toBe(404);

    await bare.close();
  });
});

describe('there is no lifecycle or settings route in this sub-phase', () => {
  it.each([
    { method: 'DELETE', url: siteUrl },
    { method: 'POST', url: `${siteUrl}/archive` },
    { method: 'POST', url: `${siteUrl}/restore` },
    { method: 'GET', url: `${siteUrl}/settings` },
    { method: 'PATCH', url: `${siteUrl}/settings` },
    { method: 'PATCH', url: `${siteUrl}/autopilot` },
  ] as const)('does not serve $method $url', async ({ method, url }) => {
    await login();

    const response = await app.inject({
      method,
      url,
      headers: { ...jar.headersFor(config), 'content-type': 'application/json' },
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(lastCall).toBeNull();
  });
});

describe('reading', () => {
  it('returns a bounded page in the contract shape', async () => {
    await login();

    const response = await get(sitesUrl);

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');

    const body = siteListResponseSchema.parse(response.json());

    expect(body.sites).toHaveLength(1);
    expect(body.sites[0]?.id).toBe(SITE_ID);
    expect(body.page).toEqual({ limit: 50, nextCursor: null });
    // No total: the only honest count is "rows this caller may reach".
    expect(Object.keys(body.page)).toEqual(['limit', 'nextCursor']);
  });

  it('forwards both routing ids and applies the default limit', async () => {
    await login();

    await get(sitesUrl);

    expect(lastCall?.method).toBe('listSites');
    expect(lastCall?.args[1]).toBe(ORGANIZATION_ID);
    expect(lastCall?.args[2]).toBe(CLIENT_ID);
    expect(lastCall?.args[3]).toEqual({ limit: 50 });
  });

  it('accepts the maximum limit', async () => {
    await login();

    expect((await get(`${sitesUrl}?limit=100`)).statusCode).toBe(200);
    expect(lastCall?.args[3]).toEqual({ limit: 100 });
  });

  it.each(['101', '0', '-1', '1.5', 'ten', ''])(
    'refuses limit=%s with 400 and never calls the service',
    async (limit) => {
      await login();

      const response = await get(`${sitesUrl}?limit=${limit}`);

      expect(response.statusCode).toBe(400);
      expect(lastCall).toBeNull();
    },
  );

  it('refuses an unknown query parameter', async () => {
    await login();

    expect((await get(`${sitesUrl}?page=2`)).statusCode).toBe(400);
    expect(lastCall).toBeNull();
  });

  it('forwards a cursor and answers 400 when it does not decode', async () => {
    await login();

    await get(`${sitesUrl}?cursor=abc`);
    expect(lastCall?.args[3]).toEqual({ limit: 50, cursor: 'abc' });

    refusal = 'invalid_cursor';
    const response = await get(`${sitesUrl}?cursor=abc`);

    expect(response.statusCode).toBe(400);
    expect(problemDetailsSchema.parse(response.json()).status).toBe(400);
  });

  it('returns a single site in the contract shape without tenant identifiers', async () => {
    await login();

    const response = await get(siteUrl);

    expect(response.statusCode).toBe(200);

    const body = siteResponseSchema.parse(response.json());

    expect(body.site.id).toBe(SITE_ID);
    expect(body.site.autopilotMode).toBe('review');
    expect(Object.keys(body.site)).not.toContain('organizationId');
    expect(Object.keys(body.site)).not.toContain('clientId');
    expect(lastCall?.args[3]).toBe(SITE_ID);
  });

  it('exposes no execution-policy settings beyond the autopilot mode', async () => {
    await login();

    const body = (await get(siteUrl)).json<Record<string, Record<string, unknown>>>();
    const site = body.site ?? {};

    for (const key of [
      'graduationPolicy',
      'riskOverrides',
      'modelRouterOverrides',
      'ingestionOverrides',
      'crawlSchedule',
      'crawlBudget',
      'retentionOverrides',
      'graduatedAt',
      'graduationApprovedBy',
    ]) {
      expect(Object.keys(site)).not.toContain(key);
    }
  });
});

describe('writing', () => {
  it('creates with 201 and forwards neither a caller-supplied organization nor client id', async () => {
    await login();

    const response = await send('POST', sitesUrl, {
      baseUrl: '  https://example.test  ',
      timezone: 'Asia/Jerusalem',
    });

    expect(response.statusCode).toBe(201);
    expect(lastCall?.args[1]).toBe(ORGANIZATION_ID);
    expect(lastCall?.args[2]).toBe(CLIENT_ID);
    expect(lastCall?.args[3]).toEqual({
      baseUrl: 'https://example.test',
      timezone: 'Asia/Jerusalem',
    });
  });

  it.each([
    {},
    { baseUrl: '' },
    { baseUrl: '   ' },
    { baseUrl: 'https://example.test', organizationId: '018f9e1a-0000-7000-8000-0000000000ff' },
    { baseUrl: 'https://example.test', clientId: '018f9e1a-0000-7000-8000-0000000000ff' },
    { baseUrl: 'https://example.test', id: '018f9e1a-0000-7000-8000-0000000000ff' },
    { baseUrl: 'https://example.test', autopilotMode: 'safe_autopilot' },
    { baseUrl: 'https://example.test', status: 'archived' },
    { baseUrl: 'https://example.test', cmsType: 'wordpress' },
    { baseUrl: 'https://example.test', crawlBudget: {} },
    { baseUrl: 'https://example.test', wordpressAppPassword: 'secret' },
    { baseUrl: 'https://example.test', createdAt: '2026-01-01T00:00:00.000Z' },
  ])('refuses create body %j with 400 and never calls the service', async (payload) => {
    await login();

    const response = await send('POST', sitesUrl, payload);

    expect(response.statusCode).toBe(400);
    expect(problemDetailsSchema.parse(response.json()).status).toBe(400);
    expect(lastCall).toBeNull();
  });

  it('answers a base-URL conflict with 409 and names no other resource', async () => {
    await login();
    refusal = 'conflict';

    const response = await send('POST', sitesUrl, { baseUrl: 'https://example.test' });
    const problem = problemDetailsSchema.parse(response.json());

    expect(response.statusCode).toBe(409);
    expect(problem.status).toBe(409);
    expect(problem.detail).not.toContain(CLIENT_ID);
    expect(problem.detail).not.toContain(SITE_ID);
  });

  it('answers an unnormalizable value with 400 that does not echo it back', async () => {
    await login();
    refusal = 'invalid_input';

    const response = await send('POST', sitesUrl, { baseUrl: 'ftp://example.test' });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('ftp://example.test');
    expect(response.body).not.toContain('unsupported_scheme');
    // The reason is logged instead, so a caller support question is still answerable.
    expect(logLines.some((line) => line.includes('unsupported_scheme'))).toBe(true);
  });

  it('patches only the fields that were sent', async () => {
    await login();

    const response = await send('PATCH', siteUrl, { timezone: 'UTC' });

    expect(response.statusCode).toBe(200);
    expect(lastCall?.args[2]).toBe(CLIENT_ID);
    expect(lastCall?.args[3]).toBe(SITE_ID);
    expect(lastCall?.args[4]).toEqual({ timezone: 'UTC' });
  });

  it.each([
    {},
    { id: '018f9e1a-0000-7000-8000-0000000000ff' },
    { organizationId: '018f9e1a-0000-7000-8000-0000000000ff' },
    { clientId: '018f9e1a-0000-7000-8000-0000000000ff' },
    { createdAt: '2026-01-01T00:00:00.000Z' },
    { updatedAt: '2026-01-01T00:00:00.000Z' },
    { status: 'archived' },
    { cmsType: 'wordpress' },
    { autopilotMode: 'safe_autopilot' },
    { siteSettings: { autopilotMode: 'review' } },
    { graduationPolicy: {} },
    { riskOverrides: {} },
    { crawlBudget: {} },
    { baseUrl: '' },
    { unknown: true },
  ])('refuses patch body %j with 400 and never calls the service', async (payload) => {
    await login();

    const response = await send('PATCH', siteUrl, payload);

    expect(response.statusCode).toBe(400);
    expect(lastCall).toBeNull();
  });

  it('cannot move a site to another client, because no body field names one', async () => {
    await login();

    const response = await send('PATCH', siteUrl, {
      clientId: '018f9e1a-0000-7000-8000-0000000000ff',
      timezone: 'UTC',
    });

    expect(response.statusCode).toBe(400);
    expect(lastCall).toBeNull();
  });
});

describe('refusals are mapped without revealing what exists', () => {
  const cases = [
    { failure: 'permission_denied', status: 403 },
    { failure: 'no_membership', status: 404 },
    { failure: 'malformed_organization_id', status: 404 },
    { failure: 'resource_not_in_organization', status: 404 },
    { failure: 'client_out_of_scope', status: 404 },
  ] as const;

  it.each(cases)('maps $failure to $status', async ({ failure, status }) => {
    await login();
    refusal = failure;

    const response = await get(siteUrl);

    expect(response.statusCode).toBe(status);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(problemDetailsSchema.parse(response.json()).status).toBe(status);
  });

  it('answers a foreign site and an out-of-scope parent client with identical bodies', async () => {
    await login();

    refusal = 'resource_not_in_organization';
    const foreign = await get(siteUrl);

    refusal = 'client_out_of_scope';
    const outOfScope = await get(siteUrl);

    const strip = (response: LightMyRequestResponse): unknown => {
      const problem = problemDetailsSchema.parse(response.json());
      return {
        type: problem.type,
        title: problem.title,
        status: problem.status,
        detail: problem.detail,
        instance: problem.instance,
        code: problem.code,
      };
    };

    expect(foreign.statusCode).toBe(outOfScope.statusCode);
    expect(strip(foreign)).toEqual(strip(outOfScope));
    // Neither carries a `code`: a machine-readable discriminator here would rebuild
    // exactly the oracle the shared 404 exists to remove.
    expect(problemDetailsSchema.parse(foreign.json()).code).toBeUndefined();
  });

  it('logs the refusal without putting it in the response', async () => {
    await login();
    refusal = 'client_out_of_scope';

    const response = await get(siteUrl);

    expect(logLines.some((line) => line.includes('client_out_of_scope'))).toBe(true);
    expect(response.body).not.toContain('client_out_of_scope');
  });
});
