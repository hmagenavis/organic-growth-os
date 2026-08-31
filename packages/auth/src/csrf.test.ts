import { describe, expect, it } from 'vitest';

import {
  ANONYMOUS_CSRF_BINDING,
  isStateChangingMethod,
  issueCsrfToken,
  verifyCsrfToken,
} from './csrf.js';

const SECRET = 'a'.repeat(64);
const OTHER_SECRET = 'b'.repeat(64);
const SESSION = '0198f0c3-0000-7000-8000-000000000001';

function verify(overrides: {
  binding?: string;
  cookieToken?: string | undefined;
  requestToken?: string | undefined;
  secret?: string;
}): string {
  return verifyCsrfToken({
    secret: overrides.secret ?? SECRET,
    binding: overrides.binding ?? SESSION,
    cookieToken: overrides.cookieToken,
    requestToken: overrides.requestToken,
  });
}

describe('CSRF token issuance', () => {
  it('produces a nonce and a signature', () => {
    const token = issueCsrfToken(SECRET, SESSION);
    const [nonce, signature] = token.split('.');

    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => issueCsrfToken(SECRET, SESSION)));
    expect(tokens.size).toBe(500);
  });

  it('encodes nothing about the binding it is bound to', () => {
    // The MAC covers the binding; the token does not carry it.
    expect(issueCsrfToken(SECRET, SESSION)).not.toContain(SESSION);
    expect(issueCsrfToken(SECRET, 'someone@example.test')).not.toContain('example.test');
  });
});

describe('CSRF verification', () => {
  it('accepts a token that matches its cookie and verifies for the binding', () => {
    const token = issueCsrfToken(SECRET, SESSION);
    expect(verify({ cookieToken: token, requestToken: token })).toBe('ok');
  });

  it('rejects a missing cookie token', () => {
    const token = issueCsrfToken(SECRET, SESSION);

    expect(verify({ cookieToken: undefined, requestToken: token })).toBe('missing_cookie_token');
    expect(verify({ cookieToken: '', requestToken: token })).toBe('missing_cookie_token');
  });

  it('rejects a missing request token', () => {
    const token = issueCsrfToken(SECRET, SESSION);

    expect(verify({ cookieToken: token, requestToken: undefined })).toBe('missing_request_token');
    expect(verify({ cookieToken: token, requestToken: '' })).toBe('missing_request_token');
  });

  it('rejects two valid tokens that are not the same token', () => {
    expect(
      verify({
        cookieToken: issueCsrfToken(SECRET, SESSION),
        requestToken: issueCsrfToken(SECRET, SESSION),
      }),
    ).toBe('token_mismatch');
  });

  it('rejects a token that is not one we signed', () => {
    // The cookie-injection case: an attacker who can set a cookie on the victim's
    // origin still cannot produce a valid MAC.
    const forged = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA';

    expect(verify({ cookieToken: forged, requestToken: forged })).toBe('invalid_signature');
  });

  it('rejects a token signed with a different secret', () => {
    const token = issueCsrfToken(OTHER_SECRET, SESSION);
    expect(verify({ cookieToken: token, requestToken: token })).toBe('invalid_signature');
  });

  it('rejects a token bound to a different session', () => {
    // Session fixation via CSRF: the attacker's own token is useless on a victim's
    // session.
    const attackerToken = issueCsrfToken(SECRET, '0198f0c3-0000-7000-8000-0000000000ff');

    expect(verify({ cookieToken: attackerToken, requestToken: attackerToken })).toBe(
      'invalid_signature',
    );
  });

  it('rejects an anonymous token on an authenticated request and vice versa', () => {
    const anonymous = issueCsrfToken(SECRET, ANONYMOUS_CSRF_BINDING);
    const bound = issueCsrfToken(SECRET, SESSION);

    expect(verify({ cookieToken: anonymous, requestToken: anonymous })).toBe('invalid_signature');
    expect(
      verify({ binding: ANONYMOUS_CSRF_BINDING, cookieToken: bound, requestToken: bound }),
    ).toBe('invalid_signature');
  });

  it('accepts an anonymous token on an unauthenticated request, which login needs', () => {
    const token = issueCsrfToken(SECRET, ANONYMOUS_CSRF_BINDING);

    expect(
      verify({ binding: ANONYMOUS_CSRF_BINDING, cookieToken: token, requestToken: token }),
    ).toBe('ok');
  });

  it('rejects a tampered signature', () => {
    const token = issueCsrfToken(SECRET, SESSION);
    const [nonce, signature = ''] = token.split('.');
    const tampered = `${String(nonce)}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;

    expect(verify({ cookieToken: tampered, requestToken: tampered })).toBe('invalid_signature');
  });

  it('rejects a structurally broken token without throwing', () => {
    for (const broken of ['no-separator', '.only-signature', 'only-nonce.', '.']) {
      const verdict = verify({ cookieToken: broken, requestToken: broken });
      expect(verdict === 'malformed_token' || verdict === 'invalid_signature').toBe(true);
    }
  });
});

describe('method classification', () => {
  it('treats reads as safe', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head']) {
      expect(isStateChangingMethod(method)).toBe(false);
    }
  });

  it('treats every mutating method as state-changing', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      expect(isStateChangingMethod(method)).toBe(true);
    }
  });
});
