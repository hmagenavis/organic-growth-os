import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { secretEquals } from './tokens.js';

/**
 * CSRF protection: signed double-submit token (docs/SECURITY.md §2, ADR-0013).
 *
 * A request is accepted only when all three hold:
 *
 *   1. the CSRF cookie and the request header carry the same token;
 *   2. the token's signature verifies under the server secret — so a token cannot be
 *      minted by anyone else, which is what defeats cookie injection from a sibling
 *      subdomain (a plain unsigned double-submit does not);
 *   3. the signature covers the *binding*: the current session id, or `anonymous`
 *      before login. A token issued for the attacker's own session is therefore
 *      useless against a victim's session.
 *
 * `SameSite` remains configured on the session cookie but is treated strictly as
 * defense in depth, never as the control.
 *
 * The token carries no information: it is a random nonce plus a MAC over
 * (binding, nonce). Nothing sensitive is encoded in it, and it is never persisted.
 */

/** Binding used before a session exists (the login request itself). */
export const ANONYMOUS_CSRF_BINDING = 'anonymous';

/** Header the browser echoes the cookie value in. Custom headers cannot be set by a
 * cross-origin form post, which is a second, independent obstacle for an attacker. */
export const CSRF_HEADER_NAME = 'x-csrf-token';

const NONCE_BYTES = 32;

export type CsrfVerdict =
  | 'ok'
  | 'missing_cookie_token'
  | 'missing_request_token'
  | 'token_mismatch'
  | 'malformed_token'
  | 'invalid_signature';

function sign(secret: string, binding: string, nonce: string): string {
  return createHmac('sha256', secret).update(`${binding}:${nonce}`, 'utf8').digest('base64url');
}

/**
 * Issues a token bound to `binding` — a session id after login, or
 * `ANONYMOUS_CSRF_BINDING` before it.
 */
export function issueCsrfToken(secret: string, binding: string): string {
  const nonce = randomBytes(NONCE_BYTES).toString('base64url');
  return `${nonce}.${sign(secret, binding, nonce)}`;
}

function signatureMatches(secret: string, binding: string, token: string): boolean {
  const separator = token.indexOf('.');

  if (separator <= 0 || separator === token.length - 1) {
    return false;
  }

  const nonce = token.slice(0, separator);
  const provided = Buffer.from(token.slice(separator + 1), 'base64url');
  const expected = Buffer.from(sign(secret, binding, nonce), 'base64url');

  if (provided.length !== expected.length || provided.length === 0) {
    return false;
  }

  return timingSafeEqual(provided, expected);
}

export interface VerifyCsrfInput {
  readonly secret: string;
  /** Session id of the authenticated request, or `ANONYMOUS_CSRF_BINDING`. */
  readonly binding: string;
  readonly cookieToken: string | undefined;
  readonly requestToken: string | undefined;
}

/**
 * Verifies a state-changing request. Returns a coarse verdict suitable for logging;
 * the token values themselves are never included in it.
 */
export function verifyCsrfToken(input: VerifyCsrfInput): CsrfVerdict {
  const { secret, binding, cookieToken, requestToken } = input;

  if (cookieToken === undefined || cookieToken === '') {
    return 'missing_cookie_token';
  }

  if (requestToken === undefined || requestToken === '') {
    return 'missing_request_token';
  }

  if (!secretEquals(cookieToken, requestToken)) {
    return 'token_mismatch';
  }

  if (!cookieToken.includes('.')) {
    return 'malformed_token';
  }

  return signatureMatches(secret, binding, cookieToken) ? 'ok' : 'invalid_signature';
}

/** HTTP methods that must not change state and are therefore not CSRF-checked. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

export function isStateChangingMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}
