import {
  PROBLEM_CONTENT_TYPE,
  healthResponseSchema,
  problemDetailsSchema,
  readinessResponseSchema,
} from '@organic-os/contracts';
import { createLogger } from '@organic-os/observability';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';

let app: FastifyInstance | undefined;

function createApp(startedAt = Date.now(), checkReady?: () => Promise<boolean>): FastifyInstance {
  app = buildApp({
    logger: createLogger({ name: 'api-test', level: 'silent' }),
    serviceVersion: '1.2.3-test',
    startedAt,
    ...(checkReady === undefined ? {} : { checkReady }),
  });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health', () => {
  it('returns a contract-valid health response', async () => {
    const response = await createApp().inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);

    const parsed = healthResponseSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      status: 'ok',
      service: 'api',
      version: '1.2.3-test',
    });
  });

  it('reports uptime derived from process start', async () => {
    const response = await createApp(Date.now() - 5_000).inject({
      method: 'GET',
      url: '/health',
    });

    const parsed = healthResponseSchema.parse(response.json());
    expect(parsed.uptimeSeconds).toBeGreaterThanOrEqual(5);
  });

  it('is not cacheable and forbids content sniffing', async () => {
    const response = await createApp().inject({ method: 'GET', url: '/health' });

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not set cross-origin access headers', async () => {
    const response = await createApp().inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://attacker.example' },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('error handling', () => {
  it('answers unknown routes with RFC 9457 problem details', async () => {
    const response = await createApp().inject({ method: 'GET', url: '/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);

    const parsed = problemDetailsSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ status: 404, title: 'Not Found' });
  });

  it('includes a request id so a report can be traced to server logs', async () => {
    const response = await createApp().inject({ method: 'GET', url: '/does-not-exist' });

    const problem = problemDetailsSchema.parse(response.json());
    expect(problem.requestId).toBeTypeOf('string');
    expect(problem.requestId?.length).toBeGreaterThan(0);
  });
});

describe('GET /health/ready', () => {
  it('is ready when no dependency is configured', async () => {
    const response = await createApp().inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(readinessResponseSchema.parse(response.json())).toMatchObject({
      status: 'ready',
      service: 'api',
      version: '1.2.3-test',
    });
  });

  it('is ready when the dependency probe succeeds', async () => {
    const response = await createApp(Date.now(), () => Promise.resolve(true)).inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(200);
    expect(readinessResponseSchema.parse(response.json()).status).toBe('ready');
  });

  it('answers 503 when the dependency probe fails', async () => {
    // 503 rather than 500: the process is fine, it just must not receive traffic.
    const response = await createApp(Date.now(), () => Promise.resolve(false)).inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(503);
    expect(readinessResponseSchema.parse(response.json()).status).toBe('not_ready');
  });

  it('never reveals which dependency failed or why', async () => {
    const response = await createApp(Date.now(), () => Promise.resolve(false)).inject({
      method: 'GET',
      url: '/health/ready',
    });

    const body = response.body.toLowerCase();
    for (const forbidden of [
      'database',
      'postgres',
      'connection',
      'password',
      'host',
      'econnrefused',
    ]) {
      expect(body).not.toContain(forbidden);
    }

    expect(Object.keys(readinessResponseSchema.parse(response.json())).sort()).toEqual(
      ['service', 'status', 'version'].sort(),
    );
  });

  it('is liveness-independent: /health stays 200 while readiness is 503', async () => {
    const instance = createApp(Date.now(), () => Promise.resolve(false));

    const live = await instance.inject({ method: 'GET', url: '/health' });
    const ready = await instance.inject({ method: 'GET', url: '/health/ready' });

    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
  });

  it('is not cacheable', async () => {
    const response = await createApp().inject({ method: 'GET', url: '/health/ready' });

    expect(response.headers['cache-control']).toBe('no-store');
  });
});
