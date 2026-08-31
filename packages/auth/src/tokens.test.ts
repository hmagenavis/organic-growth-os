import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
  secretEquals,
  SESSION_TOKEN_BYTES,
  SESSION_TOKEN_LENGTH,
} from './tokens.js';

describe('session token generation', () => {
  it('carries 256 bits of entropy', () => {
    expect(SESSION_TOKEN_BYTES).toBe(32);
    expect(Buffer.from(generateSessionToken(), 'base64url')).toHaveLength(SESSION_TOKEN_BYTES);
  });

  it('is url-safe and fixed length', () => {
    const token = generateSessionToken();

    expect(token).toHaveLength(SESSION_TOKEN_LENGTH);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never repeats across a large sample', () => {
    const tokens = new Set(Array.from({ length: 2_000 }, () => generateSessionToken()));
    expect(tokens.size).toBe(2_000);
  });
});

describe('session token hashing', () => {
  it('is SHA-256 of the token', () => {
    const token = generateSessionToken();

    expect(hashSessionToken(token)).toEqual(createHash('sha256').update(token, 'utf8').digest());
    expect(hashSessionToken(token)).toHaveLength(32);
  });

  it('is deterministic, so the same cookie always resolves the same session', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toEqual(hashSessionToken(token));
  });

  it('does not contain the token it was derived from', () => {
    const token = generateSessionToken();
    const digest = hashSessionToken(token);

    expect(digest.toString('base64url')).not.toBe(token);
    expect(digest.toString('utf8')).not.toContain(token);
    expect(digest.toString('hex')).not.toContain(Buffer.from(token, 'utf8').toString('hex'));
  });

  it('separates tokens that differ by one character', () => {
    expect(hashSessionToken('a'.repeat(43))).not.toEqual(hashSessionToken(`${'a'.repeat(42)}b`));
  });
});

describe('token well-formedness', () => {
  it('accepts what the generator produces', () => {
    expect(isWellFormedSessionToken(generateSessionToken())).toBe(true);
  });

  it('rejects anything else before it becomes a query parameter', () => {
    expect(isWellFormedSessionToken('')).toBe(false);
    expect(isWellFormedSessionToken('short')).toBe(false);
    expect(isWellFormedSessionToken('x'.repeat(SESSION_TOKEN_LENGTH + 1))).toBe(false);
    expect(isWellFormedSessionToken(`${'x'.repeat(SESSION_TOKEN_LENGTH - 1)}'`)).toBe(false);
    expect(isWellFormedSessionToken(`${'x'.repeat(SESSION_TOKEN_LENGTH - 1)}%`)).toBe(false);
  });
});

describe('secretEquals', () => {
  it('compares equal values as equal and unequal values as unequal', () => {
    expect(secretEquals('abc', 'abc')).toBe(true);
    expect(secretEquals('abc', 'abd')).toBe(false);
  });

  it('handles different lengths without throwing', () => {
    expect(secretEquals('a', 'a-much-longer-value')).toBe(false);
    expect(secretEquals('', '')).toBe(true);
  });
});
