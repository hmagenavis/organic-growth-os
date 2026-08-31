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
