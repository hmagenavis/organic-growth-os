import { describe, expect, it } from 'vitest';

import { parseTrustProxy } from './http.js';

describe('parseTrustProxy', () => {
  it('defaults to not trusting anything', () => {
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('  FALSE  ')).toBe(false);
  });

  it('refuses `true`, which would trust a header from anyone', () => {
    expect(() => parseTrustProxy('true')).toThrow(/must not be/);
  });

  it('refuses a hop count, which fastify@5 maps to trusting nothing', () => {
    expect(() => parseTrustProxy('1')).toThrow(/hop count/);
    expect(() => parseTrustProxy('0')).toThrow(/hop count/);
  });

  it('accepts addresses, CIDR blocks and Fastify address groups', () => {
    expect(parseTrustProxy('10.0.0.4')).toEqual(['10.0.0.4']);
    expect(parseTrustProxy('10.0.0.0/8, 172.16.0.0/12')).toEqual(['10.0.0.0/8', '172.16.0.0/12']);
    expect(parseTrustProxy('loopback,uniquelocal')).toEqual(['loopback', 'uniquelocal']);
    expect(parseTrustProxy('::1/128')).toEqual(['::1/128']);
  });

  it('rejects anything that is not an address, a block or a known group', () => {
    expect(() => parseTrustProxy('proxy.example.com')).toThrow(/IP addresses/);
    expect(() => parseTrustProxy('10.0.0.4/33')).toThrow(/IP addresses/);
    expect(() => parseTrustProxy('999.0.0.1')).toThrow(/IP addresses/);
  });

  it('never echoes the offending value', () => {
    const value = 'super-secret-value-42';
    expect(() => parseTrustProxy(value)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(value) as unknown as string }),
    );
  });
});
