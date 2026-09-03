import { createAuthConfig, type AuthConfig } from '@organic-os/auth';
import {
  createAuthorizationService,
  createAuthStore,
  createClientService,
  createMemberAdministrationService,
  createMembershipStore,
  createSiteService,
  provisionFirstOrganization,
} from '@organic-os/database';
import { createTestDatabase, type TestDatabase } from '@organic-os/database/testing';
import { createLogger, type LogDestination } from '@organic-os/observability';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { buildApp } from '../app.js';
import { buildAuthDependencies } from '../auth/build.js';
import { TEST_AUTH_ENV, testPasswordHasher } from '../testing/auth-helpers.js';
import { runVerification } from './verification.js';

/**
 * The end-to-end verification command, verified.
 *
 * `pnpm verify:e2e` is what a human runs against a real deployment, so it is the one
 * piece of this repository whose failure mode is "it silently checked nothing". It is
 * therefore run here the way an operator runs it — over a real socket, with real
 * cookies, against a real PostgreSQL — with the whole matrix required to pass.
 *
 * The password here is a fixture in a disposable database, which is why this test may
 * hold one at all. The command itself still refuses to take one from anywhere but a
 * terminal; that is `verify-e2e.ts`, and nothing in this file changes it.
 */

const PASSWORD = 'correct horse battery staple';
const EMAIL = 'verify-e2e@example.test';

let database: TestDatabase;
let app: FastifyInstance;
let config: AuthConfig;
let api: string;

const destination: LogDestination = {
  write(): void {
    // The command prints its own report; the server's log is noise here.
  },
};

beforeAll(async () => {
  database = await createTestDatabase(inject('postgresAdminUri'), 'organic_os_verify_e2e_test');

  await provisionFirstOrganization(database.provisioner.db, {
    organization: { name: 'Verify E2E', slug: 'verify-e2e' },
    admin: {
      kind: 'new_user',
      email: EMAIL,
      name: 'Verify E2E Admin',
      passwordHash: await testPasswordHasher.hash(PASSWORD),
    },
  });

  config = createAuthConfig({ ...TEST_AUTH_ENV, AUTH_LOGIN_RATE_LIMIT_ACCOUNT_MAX: '40' });

  const authorization = createAuthorizationService({
    db: database.runtime.db,
    store: createMembershipStore(database.runtime.db),
  });

  app = buildApp({
    logger: createLogger({ name: 'verify-e2e-int', level: 'silent' }, destination),
    serviceVersion: '0.0.0-test',
    auth: buildAuthDependencies({ store: createAuthStore(database.runtime.db), config }),
    authorization,
    // Everything `apps/api/src/index.ts` wires, because the command checks the whole
    // deployed surface and a route that is merely unwired answers 404 like a route
    // that is broken.
    memberAdministration: createMemberAdministrationService({
      authorization,
      db: database.runtime.db,
    }),
    clients: createClientService({ authorization }),
    sites: createSiteService({ authorization }),
    checkReady: () => Promise.resolve(true),
  });

  // A real socket, not `inject`: the command talks HTTP, and that is the thing under
  // test as much as the endpoints are.
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('the test server did not bind a TCP port');
  }

  api = `http://127.0.0.1:${String(address.port)}`;
}, 240_000);

afterAll(async () => {
  await app?.close();
  await database?.close();
});

describe('pnpm verify:e2e', () => {
  it('passes every check against a correctly deployed API', async () => {
    await expect(runVerification({ api, email: EMAIL, password: PASSWORD })).resolves.toBe(true);
  });

  it('is idempotent: a second run reuses its fixtures and still passes', async () => {
    // The first run created the verification client and site. There is no deletion
    // endpoint in Phase 0.4.2, so re-running has to reuse them rather than fail on the
    // unique base URL — which is exactly what an operator will do.
    await expect(runVerification({ api, email: EMAIL, password: PASSWORD })).resolves.toBe(true);
  });

  it('refuses to report success when the password is wrong', async () => {
    await expect(
      runVerification({ api, email: EMAIL, password: `${PASSWORD} but wrong` }),
    ).rejects.toThrow(/login failed/);
  });

  it('refuses to report success when nothing is listening', async () => {
    await expect(
      runVerification({ api: 'http://127.0.0.1:1', email: EMAIL, password: PASSWORD }),
    ).rejects.toThrow();
  });
});
