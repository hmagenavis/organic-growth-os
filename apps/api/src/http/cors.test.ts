import { CSRF_HEADER_NAME } from '@organic-os/auth';
import { createLogger } from '@organic-os/observability';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';

const ALLOWED = 'https://app.example.com';
const OTHER = 'https://evil.example.com';

let app: FastifyInstance | undefined;

function createApp(allowedOrigins: readonly string[]): FastifyInstance {
  app = buildApp({
    logger: createLogger({ name: 'cors-test', level: 'silent' }),
    serviceVersion: '1.2.3-test',
    cors: { allowedOrigins },
  });
  return app;
}

function preflight(instance: FastifyInstance, origin: string, method = 'POST') {
  return instance.inject({
    method: 'OPTIONS',
    url: '/health',
    headers: { origin, 'access-control-request-method': method },
  });
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('an allowed origin', () => {
  it('is echoed exactly, with credentials, on an actual request', async () => {
    const response = await createApp([ALLOWED]).inject({
      method: 'GET',
      url: '/health',
      headers: { origin: ALLOWED },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('gets a 204 preflight naming the methods and the CSRF header', async () => {
    const response = await preflight(createApp([ALLOWED]), ALLOWED);

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-methods']).toContain('PATCH');
    expect(response.headers['access-control-allow-headers']).toContain(CSRF_HEADER_NAME);
    expect(response.headers['access-control-max-age']).toBe('600');
  });

  it('marks the response as varying by origin so a cache cannot cross-serve it', async () => {
    const response = await createApp([ALLOWED]).inject({
      method: 'GET',
      url: '/health',
      headers: { origin: ALLOWED },
    });

    expect(String(response.headers.vary).toLowerCase()).toContain('origin');
  });

  it('is matched exactly — not by prefix, suffix or scheme', async () => {
    const instance = createApp([ALLOWED]);

    for (const origin of [
      'https://app.example.com.evil.test',
      'https://evil-app.example.com',
      'http://app.example.com',
      'https://app.example.com:8443',
      'https://APP.example.com',
    ]) {
      const response = await instance.inject({
        method: 'GET',
        url: '/health',
        headers: { origin },
      });

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
  });
});

describe('an origin that is not allowed', () => {
  it('has its preflight refused', async () => {
    const response = await preflight(createApp([ALLOWED]), OTHER);

    expect(response.statusCode).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('gets no grant on an actual request, which is how the browser is told no', async () => {
    const response = await createApp([ALLOWED]).inject({
      method: 'GET',
      url: '/health',
      headers: { origin: OTHER },
    });

    // The request itself still runs: the same-origin proxy topology delivers a
    // browser's own Origin header here, and refusing it would break login. Nothing is
    // granted, so a cross-site caller cannot read this.
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('an empty allowlist', () => {
  it('grants nothing to any origin', async () => {
    const response = await createApp([]).inject({
      method: 'GET',
      url: '/health',
      headers: { origin: ALLOWED },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers.vary).toBeUndefined();
  });

  it('still refuses a preflight', async () => {
    expect((await preflight(createApp([]), ALLOWED)).statusCode).toBe(403);
  });

  it('leaves same-origin requests, which carry no Origin, untouched', async () => {
    const response = await createApp([]).inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('a deployment that wires no policy at all', () => {
  it('emits no CORS header of any kind', async () => {
    app = buildApp({
      logger: createLogger({ name: 'cors-test', level: 'silent' }),
      serviceVersion: '1.2.3-test',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: ALLOWED },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('the wildcard', () => {
  it('cannot be configured, because an origin is matched as an exact string', async () => {
    const response = await createApp(['*']).inject({
      method: 'GET',
      url: '/health',
      headers: { origin: ALLOWED },
    });

    // `parseAllowedOrigins` refuses `*` before it can reach here; even if one did, it
    // would match no browser's Origin header.
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
