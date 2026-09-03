import { describe, expect, it } from 'vitest';

import { EnvValidationError } from './errors.js';
import { parseServerEnv, serverEnv } from './server.js';

describe('parseServerEnv', () => {
  it('applies defaults when nothing is set', () => {
    const env = parseServerEnv({});

    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('0.0.0-dev');
    expect(env.API_HOST).toBe('127.0.0.1');
    expect(env.API_PORT).toBe(3001);
    expect(env.API_TRUST_PROXY).toBe(false);
    expect(env.CORS_ALLOWED_ORIGINS).toEqual([]);
    expect(env.WORKER_HEARTBEAT_INTERVAL_MS).toBe(60_000);
  });

  it('coerces numeric variables from strings', () => {
    const env = parseServerEnv({ API_PORT: '8080', WORKER_HEARTBEAT_INTERVAL_MS: '5000' });

    expect(env.API_PORT).toBe(8080);
    expect(env.WORKER_HEARTBEAT_INTERVAL_MS).toBe(5000);
  });

  it('strips unknown variables instead of passing them through', () => {
    const env = parseServerEnv({ SOME_FUTURE_SECRET: 'value' });

    expect(env).not.toHaveProperty('SOME_FUTURE_SECRET');
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseServerEnv({ API_PORT: '70000' })).toThrow(EnvValidationError);
  });

  it('rejects a non-numeric port', () => {
    expect(() => parseServerEnv({ API_PORT: 'not-a-port' })).toThrow(EnvValidationError);
  });

  it('falls back to the platform-injected PORT when API_PORT is absent', () => {
    expect(parseServerEnv({ PORT: '10000' }).API_PORT).toBe(10_000);
  });

  it('keeps API_PORT authoritative when the platform also injects PORT', () => {
    expect(parseServerEnv({ API_PORT: '3001', PORT: '10000' }).API_PORT).toBe(3001);
  });

  it('treats an empty API_PORT as absent rather than as a value', () => {
    expect(parseServerEnv({ API_PORT: '', PORT: '10000' }).API_PORT).toBe(10_000);
    expect(parseServerEnv({ API_PORT: '', PORT: '' }).API_PORT).toBe(3001);
  });

  it('does not let PORT decide the bind address', () => {
    expect(parseServerEnv({ PORT: '10000' }).API_HOST).toBe('127.0.0.1');
  });

  it('parses the proxy trust boundary and the CORS allowlist', () => {
    const env = parseServerEnv({
      API_TRUST_PROXY: 'uniquelocal',
      CORS_ALLOWED_ORIGINS: 'https://app.example.com, https://b.example.com/',
    });

    expect(env.API_TRUST_PROXY).toEqual(['uniquelocal']);
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['https://app.example.com', 'https://b.example.com']);
  });

  it('fails closed on an unusable proxy or CORS setting rather than defaulting', () => {
    expect(() => parseServerEnv({ API_TRUST_PROXY: 'true' })).toThrow(EnvValidationError);
    expect(() => parseServerEnv({ API_TRUST_PROXY: '1' })).toThrow(EnvValidationError);
    expect(() => parseServerEnv({ CORS_ALLOWED_ORIGINS: '*' })).toThrow(EnvValidationError);
    expect(() => parseServerEnv({ CORS_ALLOWED_ORIGINS: 'http://app.example.com' })).toThrow(
      EnvValidationError,
    );
  });

  it('reports the offending variable name', () => {
    let caught: unknown;

    try {
      parseServerEnv({ LOG_LEVEL: 'chatty' });
    } catch (error) {
      caught = error;
    }

    if (!(caught instanceof EnvValidationError)) {
      throw new Error('expected parseServerEnv to throw EnvValidationError');
    }

    expect(caught.issues.map((issue) => issue.path)).toContain('LOG_LEVEL');
  });

  it('never interpolates environment values into the error message', () => {
    const secretLikeValue = 'super-secret-value-42';
    let caught: unknown;

    try {
      parseServerEnv({ LOG_LEVEL: secretLikeValue, API_PORT: secretLikeValue });
    } catch (error) {
      caught = error;
    }

    if (!(caught instanceof EnvValidationError)) {
      throw new Error('expected parseServerEnv to throw EnvValidationError');
    }

    expect(caught.message).not.toContain(secretLikeValue);
    for (const issue of caught.issues) {
      expect(issue.message).not.toContain(secretLikeValue);
    }
  });
});

describe('serverEnv', () => {
  it('validates once and returns the cached configuration', () => {
    expect(serverEnv()).toBe(serverEnv());
  });
});
