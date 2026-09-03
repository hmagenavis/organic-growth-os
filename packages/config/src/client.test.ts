import { describe, expect, it } from 'vitest';

import { EnvValidationError } from './errors.js';
import { parsePublicEnv } from './client.js';

describe('parsePublicEnv', () => {
  it('falls back to the default application name', () => {
    expect(parsePublicEnv({}).NEXT_PUBLIC_APP_NAME).toBe('Organic Growth OS');
  });

  it('uses a provided application name', () => {
    expect(parsePublicEnv({ NEXT_PUBLIC_APP_NAME: 'Acme SEO' }).NEXT_PUBLIC_APP_NAME).toBe(
      'Acme SEO',
    );
  });

  it('rejects an empty application name', () => {
    expect(() => parsePublicEnv({ NEXT_PUBLIC_APP_NAME: '' })).toThrow(EnvValidationError);
  });

  it('drops non-public variables so secrets cannot reach the browser bundle', () => {
    const env = parsePublicEnv({
      NEXT_PUBLIC_APP_NAME: 'Acme SEO',
      NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com',
      DATABASE_URL: 'postgres://placeholder@localhost/placeholder',
      API_TOKEN: 'token-value',
    });

    expect(env).not.toHaveProperty('DATABASE_URL');
    expect(env).not.toHaveProperty('API_TOKEN');
    expect(Object.keys(env).toSorted()).toEqual([
      'NEXT_PUBLIC_API_BASE_URL',
      'NEXT_PUBLIC_APP_NAME',
    ]);
  });
});

describe('NEXT_PUBLIC_API_BASE_URL', () => {
  it('is absent when nothing is configured, rather than guessed at', () => {
    expect(parsePublicEnv({}).NEXT_PUBLIC_API_BASE_URL).toBeUndefined();
    expect(
      parsePublicEnv({ NEXT_PUBLIC_API_BASE_URL: '' }).NEXT_PUBLIC_API_BASE_URL,
    ).toBeUndefined();
  });

  it('normalises an origin so a request cannot end up with a doubled slash', () => {
    expect(
      parsePublicEnv({ NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com/' })
        .NEXT_PUBLIC_API_BASE_URL,
    ).toBe('https://api.example.com');
  });

  it('refuses anything that is not an origin', () => {
    for (const value of [
      'api.example.com',
      'https://api.example.com/v1',
      'https://api.example.com?x=1',
      'https://*.example.com',
    ]) {
      expect(() => parsePublicEnv({ NEXT_PUBLIC_API_BASE_URL: value })).toThrow(EnvValidationError);
    }
  });

  it('refuses plaintext, which would send a credentialed request unencrypted', () => {
    expect(() => parsePublicEnv({ NEXT_PUBLIC_API_BASE_URL: 'http://api.example.com' })).toThrow(
      EnvValidationError,
    );
    // Loopback is the exception, for local development against an HTTP API.
    expect(
      parsePublicEnv({ NEXT_PUBLIC_API_BASE_URL: 'http://127.0.0.1:3001' })
        .NEXT_PUBLIC_API_BASE_URL,
    ).toBe('http://127.0.0.1:3001');
  });

  it('never interpolates the value into the error message', () => {
    let caught: unknown;

    try {
      parsePublicEnv({ NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com/super-secret-42' });
    } catch (error) {
      caught = error;
    }

    if (!(caught instanceof EnvValidationError)) {
      throw new Error('expected parsePublicEnv to throw EnvValidationError');
    }

    expect(caught.message).not.toContain('super-secret-42');
  });
});
