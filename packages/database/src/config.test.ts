import { describe, expect, it } from 'vitest';

import {
  DatabaseConfigError,
  describeConnection,
  isLocalConnection,
  parseDatabaseEnv,
  runtimeDatabaseEnvSchema,
} from './config.js';
import { newId } from './ids.js';

const SECRET_URL = 'postgres://runtime_user:sup3r-s3cret@db.internal:6432/organic';

describe('describeConnection', () => {
  it('describes a target without exposing credentials', () => {
    const described = describeConnection(SECRET_URL);

    expect(described).toEqual({ host: 'db.internal', port: '6432', database: 'organic' });
    expect(JSON.stringify(described)).not.toContain('sup3r-s3cret');
    expect(JSON.stringify(described)).not.toContain('runtime_user');
  });

  it('defaults the port and survives an unparsable value', () => {
    expect(describeConnection('postgres://h/db').port).toBe('5432');
    expect(describeConnection('not a url').host).toBe('(unparsable)');
  });
});

describe('isLocalConnection', () => {
  it('recognises loopback targets', () => {
    expect(isLocalConnection('postgres://u:p@localhost:5432/db')).toBe(true);
    expect(isLocalConnection('postgres://u:p@127.0.0.1:5432/db')).toBe(true);
  });

  it('rejects remote targets', () => {
    expect(isLocalConnection(SECRET_URL)).toBe(false);
  });
});

describe('parseDatabaseEnv', () => {
  it('applies documented defaults', () => {
    const env = parseDatabaseEnv(runtimeDatabaseEnvSchema, { DATABASE_URL: SECRET_URL });

    expect(env.DATABASE_MAX_CONNECTIONS).toBe(10);
    expect(env.DATABASE_STATEMENT_TIMEOUT_MS).toBe(30_000);
  });

  it('names the missing variable without echoing any value', () => {
    let caught: unknown;

    try {
      parseDatabaseEnv(runtimeDatabaseEnvSchema, { DATABASE_MAX_CONNECTIONS: SECRET_URL });
    } catch (error) {
      caught = error;
    }

    if (!(caught instanceof DatabaseConfigError)) {
      throw new Error('expected DatabaseConfigError');
    }

    expect(caught.missing).toContain('DATABASE_URL');
    expect(caught.message).not.toContain('sup3r-s3cret');
  });
});

describe('newId', () => {
  it('produces version 7 uuids', () => {
    const id = newId();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('produces unique, time-ordered values', () => {
    const ids = Array.from({ length: 50 }, () => newId());

    expect(new Set(ids).size).toBe(50);
    expect([...ids].sort()).toEqual(ids);
  });
});
