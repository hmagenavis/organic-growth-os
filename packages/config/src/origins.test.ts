import { describe, expect, it } from 'vitest';

import { parseAllowedOrigins } from './origins.js';

describe('parseAllowedOrigins', () => {
  it('is empty by default, which grants nothing', () => {
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(parseAllowedOrigins('   ')).toEqual([]);
  });

  it('accepts exact https origins and normalises them', () => {
    expect(parseAllowedOrigins('https://app.example.com')).toEqual(['https://app.example.com']);
    expect(parseAllowedOrigins('https://app.example.com/')).toEqual(['https://app.example.com']);
    expect(parseAllowedOrigins('https://a.example.com, https://b.example.com')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('keeps a port as part of the origin', () => {
    expect(parseAllowedOrigins('https://app.example.com:8443')).toEqual([
      'https://app.example.com:8443',
    ]);
  });

  it('de-duplicates', () => {
    expect(parseAllowedOrigins('https://app.example.com,https://app.example.com/')).toEqual([
      'https://app.example.com',
    ]);
  });

  it('refuses a wildcard rather than supporting one', () => {
    expect(() => parseAllowedOrigins('*')).toThrow(/wildcard/);
    expect(() => parseAllowedOrigins('https://*.example.com')).toThrow(/wildcard/);
  });

  it('refuses plaintext except on loopback', () => {
    expect(parseAllowedOrigins('http://localhost:3000')).toEqual(['http://localhost:3000']);
    expect(parseAllowedOrigins('http://127.0.0.1:3000')).toEqual(['http://127.0.0.1:3000']);
    expect(() => parseAllowedOrigins('http://app.example.com')).toThrow(/https/);
  });

  it('refuses anything that is more than an origin', () => {
    expect(() => parseAllowedOrigins('https://app.example.com/dashboard')).toThrow(/origin only/);
    expect(() => parseAllowedOrigins('https://app.example.com?x=1')).toThrow(/origin only/);
    expect(() => parseAllowedOrigins('app.example.com')).toThrow(/absolute origin/);
  });

  it('refuses an origin carrying credentials', () => {
    expect(() => parseAllowedOrigins('https://user:pass@app.example.com')).toThrow(/credentials/);
  });

  it('never echoes the offending value', () => {
    const value = 'https://app.example.com/super-secret-value-42';
    expect(() => parseAllowedOrigins(value)).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('super-secret-value-42') as unknown as string,
      }),
    );
  });
});
