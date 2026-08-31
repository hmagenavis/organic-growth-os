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
      DATABASE_URL: 'postgres://placeholder@localhost/placeholder',
      API_TOKEN: 'token-value',
    });

    expect(env).not.toHaveProperty('DATABASE_URL');
    expect(env).not.toHaveProperty('API_TOKEN');
    expect(Object.keys(env)).toEqual(['NEXT_PUBLIC_APP_NAME']);
  });
});
