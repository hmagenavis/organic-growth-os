import { describe, expect, it } from 'vitest';

import {
  CLIENT_PAGE_DEFAULT_LIMIT,
  CLIENT_PAGE_MAX_LIMIT,
  clientListQuerySchema,
  createClientRequestSchema,
  updateClientRequestSchema,
} from './clients.js';
import { healthResponseSchema } from './health.js';
import { PROBLEM_CONTENT_TYPE, problemDetailsSchema } from './problem.js';

describe('healthResponseSchema', () => {
  it('accepts a well-formed health response', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      service: 'api',
      version: '0.1.0',
      uptimeSeconds: 12,
    });

    expect(result.success).toBe(true);
  });

  it('rejects a non-ok status', () => {
    const result = healthResponseSchema.safeParse({
      status: 'degraded',
      service: 'api',
      version: '0.1.0',
      uptimeSeconds: 12,
    });

    expect(result.success).toBe(false);
  });

  it('rejects negative uptime', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      service: 'api',
      version: '0.1.0',
      uptimeSeconds: -1,
    });

    expect(result.success).toBe(false);
  });

  it('strips unknown keys so responses cannot leak extra fields', () => {
    const result = healthResponseSchema.parse({
      status: 'ok',
      service: 'api',
      version: '0.1.0',
      uptimeSeconds: 0,
      databaseUrl: 'postgres://placeholder@localhost/placeholder',
    });

    expect(result).not.toHaveProperty('databaseUrl');
  });
});

describe('problemDetailsSchema', () => {
  it('accepts a minimal problem document', () => {
    const result = problemDetailsSchema.safeParse({
      type: 'https://errors.organic-os.dev/not-found',
      title: 'Not Found',
      status: 404,
    });

    expect(result.success).toBe(true);
  });

  it('rejects a status outside the HTTP range', () => {
    const result = problemDetailsSchema.safeParse({
      type: 'https://errors.organic-os.dev/teapot',
      title: 'Teapot',
      status: 99,
    });

    expect(result.success).toBe(false);
  });

  it('exposes the RFC 9457 media type', () => {
    expect(PROBLEM_CONTENT_TYPE).toBe('application/problem+json');
  });
});

describe('clientListQuerySchema', () => {
  it('defaults to the documented page size', () => {
    const result = clientListQuerySchema.parse({});

    expect(result.limit).toBe(CLIENT_PAGE_DEFAULT_LIMIT);
    expect(result.cursor).toBeUndefined();
  });

  it('accepts the maximum limit as a query string value', () => {
    expect(clientListQuerySchema.parse({ limit: String(CLIENT_PAGE_MAX_LIMIT) }).limit).toBe(
      CLIENT_PAGE_MAX_LIMIT,
    );
  });

  it.each(['101', '0', '-1', '1.5', 'ten', ''])('rejects limit=%s', (limit) => {
    expect(clientListQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it('rejects an unknown parameter rather than ignoring it', () => {
    expect(clientListQuerySchema.safeParse({ page: '2' }).success).toBe(false);
  });
});

describe('createClientRequestSchema', () => {
  it('trims the name to match the database check constraint', () => {
    expect(createClientRequestSchema.parse({ name: '  Acme  ' }).name).toBe('Acme');
  });

  it.each([
    { name: '' },
    { name: '   ' },
    { name: 'x'.repeat(201) },
    {},
    { name: 'Acme', organizationId: '018f9e1a-0000-7000-8000-0000000000ff' },
    { name: 'Acme', id: '018f9e1a-0000-7000-8000-0000000000ff' },
    { name: 'Acme', status: 'archived' },
    { name: 'Acme', createdAt: '2026-01-01T00:00:00.000Z' },
  ])('rejects %j', (body) => {
    expect(createClientRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('updateClientRequestSchema', () => {
  it('accepts a null that clears a nullable field', () => {
    expect(updateClientRequestSchema.parse({ notes: null })).toEqual({ notes: null });
  });

  it('rejects an empty patch rather than treating it as a no-op', () => {
    expect(updateClientRequestSchema.safeParse({}).success).toBe(false);
  });

  it.each([
    { organizationId: '018f9e1a-0000-7000-8000-0000000000ff' },
    { id: '018f9e1a-0000-7000-8000-0000000000ff' },
    { status: 'archived' },
    { createdAt: '2026-01-01T00:00:00.000Z' },
    { updatedAt: '2026-01-01T00:00:00.000Z' },
    { name: '' },
    { unknown: true },
  ])('rejects %j', (body) => {
    expect(updateClientRequestSchema.safeParse(body).success).toBe(false);
  });
});
