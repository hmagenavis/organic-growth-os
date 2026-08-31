import { describe, expect, it } from 'vitest';

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
