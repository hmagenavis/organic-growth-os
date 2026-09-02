import { createAuthConfig, type AuthConfig } from '@organic-os/auth';
import { InMemoryAuthStore } from '@organic-os/auth/testing';
import { AuthorizationError, type AuthorizationFailure } from '@organic-os/authorization';
import {
  clientListResponseSchema,
  clientResponseSchema,
  problemDetailsSchema,
} from '@organic-os/contracts';
import {
  InvalidClientCursorError,
  type AuthorizationService,
  type ClientService,
  type ClientView,
} from '@organic-os/database';
import { createLogger, type LogDestination } from '@organic-os/observability';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { buildAuthDependencies } from '../auth/build.js';
import { CookieJar, TEST_AUTH_ENV, testPasswordHasher } from '../testing/auth-helpers.js';

/**
 * HTTP behaviour of the client routes: status codes, request validation, response
 * shapes, and the refusal mapping.
 *
 * The authorization *decisions* are tested where they are made — against real
 * PostgreSQL, with Row Level Security and real scope rows, in `clients.int.test.ts`.
 * What is tested here is the mapping from a refusal to a response, which is where an
 * information leak would appear, and the input validation that has to reject before
 * any of that runs.
 */

const PASSWORD = 'correct horse battery staple';
const EMAIL = 'client-routes@example.test';
const ORGANIZATION_ID = '018f9e1a-0000-7000-8000-0000000000a0';
const CLIENT_ID = '018f9e1a-0000-7000-8000-0000000000d0';

let app: FastifyInstance;
let config: AuthConfig;
let jar: CookieJar;
let logLines: string[];

/** Set by a test to make the next client call fail in a particular way. */
let refusal: AuthorizationFailure | 'invalid_cursor' | null;
/** Recorded so a test can assert what the handler forwarded to the service. */
let lastCall: { method: string; args: readonly unknown[] } | null;

const destination: LogDestination = {
  write(chunk: string): void {
    logLines.push(chunk);
  },
};

const CLIENT: ClientView = {
  id: CLIENT_ID,
  name: 'Acme',
  status: 'active',
  industry: 'retail',
  notes: null,
  createdAt: new Date('2026-08-31T10:00:00.000Z'),
  updatedAt: new Date('2026-08-31T11:00:00.000Z'),
};

/** Refuses on demand, otherwise returns a fixed client. Records what it was asked. */
function stubService(): ClientService {
  function record<T>(method: string, args: readonly unknown[], value: T): Promise<T> {
    lastCall = { method, args };

    if (refusal === 'invalid_cursor') {
      return Promise.reject(new InvalidClientCursorError());
    }

    if (refusal !== null) {
      return Promise.reject(new AuthorizationError(refusal));
    }

    return Promise.resolve(value);
  }

  return {
    listClients: async (...args) =>
      record('listClients', args, {
        clients: [CLIENT] as readonly ClientView[],
        limit: 50,
        nextCursor: null,
      }),
    getClient: async (...args) => record('getClient', args, CLIENT),
    createClient: async (...args) => record('createClient', args, CLIENT),
    updateClient: async (...args) => record('updateClient', args, CLIENT),
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
    logger: createLogger({ name: 'api-clients-test', level: 'trace' }, destination),
    serviceVersion: '0.0.0-test',
    auth: buildAuthDependencies({ store, config }),
    authorization,
    clients: stubService(),
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

const clientsUrl = `/organizations/${ORGANIZATION_ID}/clients`;
const clientUrl = `${clientsUrl}/${CLIENT_ID}`;

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
    { method: 'GET', url: clientsUrl },
    { method: 'GET', url: clientUrl },
    { method: 'POST', url: clientsUrl },
    { method: 'PATCH', url: clientUrl },
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

describe('the routes exist only when the client service is wired', () => {
  it('serves no client route at all without it', async () => {
    const bare = buildApp({
      logger: createLogger({ name: 'api-clients-bare', level: 'silent' }, destination),
      serviceVersion: '0.0.0-test',
      auth: buildAuthDependencies({ store: new InMemoryAuthStore(), config }),
      authorization,
    });

    await bare.ready();

    const response = await bare.inject({ method: 'GET', url: clientsUrl });
    expect(response.statusCode).toBe(404);

    await bare.close();
  });
});

describe('reading', () => {
  it('returns a bounded page in the contract shape', async () => {
    await login();

    const response = await get(clientsUrl);

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');

    const body = clientListResponseSchema.parse(response.json());
    expect(body.clients).toHaveLength(1);
    expect(body.page.nextCursor).toBeNull();
    // No total count in the contract: nothing can report rows the caller cannot read.
    expect(Object.keys(body.page).sort()).toEqual(['limit', 'nextCursor']);
  });

  it('applies the default limit when none is asked for', async () => {
    await login();
    await get(clientsUrl);

    expect(lastCall?.args[2]).toEqual({ limit: 50 });
  });

  it('accepts the maximum limit', async () => {
    await login();
    const response = await get(`${clientsUrl}?limit=100`);

    expect(response.statusCode).toBe(200);
    expect(lastCall?.args[2]).toEqual({ limit: 100 });
  });

  it.each(['101', '0', '-1', 'many', '10.5', ''])(
    'refuses limit=%s with 400 and never calls the service',
    async (limit) => {
      await login();
      const response = await get(`${clientsUrl}?limit=${limit}`);

      expect(response.statusCode).toBe(400);
      expect(lastCall).toBeNull();
    },
  );

  it('refuses an unknown query parameter', async () => {
    await login();
    const response = await get(`${clientsUrl}?organizationId=other`);

    expect(response.statusCode).toBe(400);
    expect(lastCall).toBeNull();
  });

  it('forwards a cursor and answers 400 when it does not decode', async () => {
    await login();
    refusal = 'invalid_cursor';

    const response = await get(`${clientsUrl}?cursor=not-a-cursor`);

    expect(response.statusCode).toBe(400);
    expect(lastCall?.args[2]).toEqual({ limit: 50, cursor: 'not-a-cursor' });
  });

  it('returns a single client in the contract shape', async () => {
    await login();

    const response = await get(clientUrl);

    expect(response.statusCode).toBe(200);
    const body = clientResponseSchema.parse(response.json());
    expect(body.client.id).toBe(CLIENT_ID);
    // The tenant identifier is never echoed into a business object.
    expect(Object.keys(body.client)).not.toContain('organizationId');
  });
});

describe('writing', () => {
  it('creates with 201 and never forwards a caller-supplied organization id', async () => {
    await login();

    const response = await send('POST', clientsUrl, {
      name: '  Acme  ',
      industry: 'retail',
    });

    expect(response.statusCode).toBe(201);
    // Trimmed to match the database CHECK, and no organization id anywhere in the
    // arguments the handler forwarded.
    expect(lastCall?.args[2]).toEqual({ name: 'Acme', industry: 'retail' });
    expect(lastCall?.args[1]).toBe(ORGANIZATION_ID);
  });

  it.each([
    { name: 'Acme', organizationId: '018f9e1a-0000-7000-8000-0000000000ff' },
    { name: 'Acme', id: '018f9e1a-0000-7000-8000-0000000000ff' },
    { name: 'Acme', status: 'archived' },
    { name: 'Acme', createdAt: '2026-01-01T00:00:00.000Z' },
    { name: '' },
    { name: '   ' },
    { name: 'x'.repeat(201) },
    {},
  ])('refuses create body %j with 400 and never calls the service', async (payload) => {
    await login();

    const response = await send('POST', clientsUrl, payload);

    expect(response.statusCode).toBe(400);
    expect(problemDetailsSchema.parse(response.json()).status).toBe(400);
    expect(lastCall).toBeNull();
  });

  it('patches only the fields that were sent', async () => {
    await login();

    const response = await send('PATCH', clientUrl, { notes: null });

    expect(response.statusCode).toBe(200);
    expect(lastCall?.args[2]).toBe(CLIENT_ID);
    expect(lastCall?.args[3]).toEqual({ notes: null });
  });

  it.each([
    { organizationId: '018f9e1a-0000-7000-8000-0000000000ff' },
    { id: '018f9e1a-0000-7000-8000-0000000000ff' },
    { status: 'archived' },
    { createdAt: '2026-01-01T00:00:00.000Z' },
    { updatedAt: '2026-01-01T00:00:00.000Z' },
    { unknown: true },
    { name: '' },
    {},
  ])('refuses patch body %j with 400 and never calls the service', async (payload) => {
    await login();

    const response = await send('PATCH', clientUrl, payload);

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

    const response = await get(clientUrl);

    expect(response.statusCode).toBe(status);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(problemDetailsSchema.parse(response.json()).status).toBe(status);
  });

  it('answers a foreign client and an out-of-scope client with identical bodies', async () => {
    await login();

    refusal = 'resource_not_in_organization';
    const foreign = await get(clientUrl);

    refusal = 'client_out_of_scope';
    const outOfScope = await get(clientUrl);

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

    await get(clientUrl);

    expect(logLines.some((line) => line.includes('client_out_of_scope'))).toBe(true);
  });
});
