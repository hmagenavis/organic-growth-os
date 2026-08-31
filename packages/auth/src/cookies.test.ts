import { describe, expect, it } from 'vitest';

import { createAuthConfig } from './config.js';
import {
  assertHostPrefixSafe,
  clearedSessionCookie,
  csrfCookie,
  InvalidCookieSpecError,
  parseCookieHeader,
  serializeCookie,
  sessionCookie,
} from './cookies.js';

const SECRET = 'x'.repeat(64);
const production = createAuthConfig({
  AUTH_SESSION_SECRET: SECRET,
  NODE_ENV: 'production',
}).cookies;
const development = createAuthConfig({
  AUTH_SESSION_SECRET: SECRET,
  NODE_ENV: 'development',
}).cookies;

const EXPIRES = new Date(Date.now() + 60 * 60 * 1_000);

describe('session cookie — production', () => {
  const header = serializeCookie(sessionCookie(production, 'opaque-token', EXPIRES));

  it('is HttpOnly, Secure, SameSite=Lax and Path=/', () => {
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
  });

  it('never carries a Domain, which __Host- forbids', () => {
    expect(header).not.toContain('Domain');
  });

  it('expires with the session it carries', () => {
    expect(header).toContain(`Expires=${EXPIRES.toUTCString()}`);
    expect(header).toMatch(/Max-Age=3[0-9]{3}\b/);
  });

  it('uses the __Host-prefixed name', () => {
    expect(header.startsWith('__Host-organic-os-session=')).toBe(true);
  });
});

describe('session cookie — development', () => {
  const header = serializeCookie(sessionCookie(development, 'opaque-token', EXPIRES));

  it('is a separate cookie, not the production one with Secure removed', () => {
    expect(header.startsWith('organic-os-dev-session=')).toBe(true);
    expect(header).not.toContain('__Host-');
  });

  it('keeps every protection that plain HTTP does not prevent', () => {
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).not.toContain('Secure');
  });
});

describe('CSRF cookie', () => {
  it('is readable by the page, which the double-submit pattern requires', () => {
    const header = serializeCookie(csrfCookie(production, 'nonce.signature', 3_600));

    expect(header).not.toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('Max-Age=3600');
  });
});

describe('clearing the session cookie', () => {
  const header = serializeCookie(clearedSessionCookie(production));

  it('empties the value and expires it immediately', () => {
    expect(header.startsWith('__Host-organic-os-session=;')).toBe(true);
    expect(header).toContain('Max-Age=0');
    expect(header).toContain(`Expires=${new Date(0).toUTCString()}`);
  });

  it('keeps the attributes a browser needs to match the original cookie', () => {
    expect(header).toContain('Path=/');
    expect(header).toContain('Secure');
    expect(header).toContain('HttpOnly');
  });
});

describe('__Host- prefix enforcement', () => {
  it('refuses a __Host- cookie without Secure', () => {
    expect(() =>
      assertHostPrefixSafe({
        name: '__Host-x',
        value: 'v',
        attributes: { httpOnly: true, secure: false, sameSite: 'lax', path: '/', maxAge: 1 },
      }),
    ).toThrow(InvalidCookieSpecError);
  });

  it('refuses a __Host- cookie scoped below the root path', () => {
    expect(() =>
      assertHostPrefixSafe({
        name: '__Host-x',
        value: 'v',
        attributes: { httpOnly: true, secure: true, sameSite: 'lax', path: '/api', maxAge: 1 },
      }),
    ).toThrow(InvalidCookieSpecError);
  });

  it('leaves unprefixed cookies alone', () => {
    expect(() =>
      assertHostPrefixSafe({
        name: 'organic-os-dev-session',
        value: 'v',
        attributes: { httpOnly: true, secure: false, sameSite: 'lax', path: '/', maxAge: 1 },
      }),
    ).not.toThrow();
  });
});

describe('parsing a Cookie header', () => {
  it('reads the cookies we set', () => {
    expect(parseCookieHeader('__Host-organic-os-session=abc; __Host-organic-os-csrf=d.e')).toEqual({
      '__Host-organic-os-session': 'abc',
      '__Host-organic-os-csrf': 'd.e',
    });
  });

  it('round-trips a serialized cookie', () => {
    const spec = sessionCookie(production, 'a-token_with-chars', EXPIRES);
    const nameValue = serializeCookie(spec).split(';')[0] ?? '';

    expect(parseCookieHeader(nameValue)[spec.name]).toBe('a-token_with-chars');
  });

  it('returns nothing for an absent or empty header', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader('')).toEqual({});
  });

  it('skips malformed pairs instead of throwing', () => {
    expect(parseCookieHeader('broken; =novalue; good=1; =')).toEqual({ good: '1' });
  });

  it('keeps the first of a duplicated name, so a later injection cannot override it', () => {
    expect(parseCookieHeader('session=real; session=injected')['session']).toBe('real');
  });

  it('has no prototype, so a cookie named __proto__ cannot poison the lookup', () => {
    const parsed = parseCookieHeader('__proto__=polluted; session=real');

    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(parsed['session']).toBe('real');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
