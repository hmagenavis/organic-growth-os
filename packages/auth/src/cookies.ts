import type { CookiePolicy } from './config.js';

/**
 * Cookie *specifications* — name, value and attributes — produced framework-free so
 * this package stays free of Fastify (or any other HTTP library). The API applies
 * them with its own cookie serializer.
 *
 * The `__Host-` prefix is not decoration: a browser rejects a `__Host-` cookie unless
 * it is `Secure`, has `Path=/` and carries no `Domain`. That makes it impossible for
 * a sibling subdomain to overwrite the session or CSRF cookie. `assertHostPrefixSafe`
 * enforces the same three conditions here, so a misconfiguration fails on our side
 * rather than being silently dropped by the browser.
 */

export interface CookieAttributes {
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: 'lax' | 'strict';
  readonly path: string;
  /** Seconds. `0` with an epoch expiry is how a cookie is cleared. */
  readonly maxAge: number;
  readonly expires?: Date;
}

export interface CookieSpec {
  readonly name: string;
  readonly value: string;
  readonly attributes: CookieAttributes;
}

export const HOST_COOKIE_PREFIX = '__Host-';

export class InvalidCookieSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCookieSpecError';
  }
}

/**
 * @throws {InvalidCookieSpecError} when a `__Host-` cookie would not satisfy the
 * prefix's requirements and would therefore be discarded by the browser.
 */
export function assertHostPrefixSafe(spec: CookieSpec): void {
  if (!spec.name.startsWith(HOST_COOKIE_PREFIX)) {
    return;
  }

  if (!spec.attributes.secure) {
    throw new InvalidCookieSpecError(`${spec.name} requires the Secure attribute`);
  }

  if (spec.attributes.path !== '/') {
    throw new InvalidCookieSpecError(`${spec.name} requires Path=/`);
  }
}

function build(
  name: string,
  value: string,
  policy: CookiePolicy,
  options: { httpOnly: boolean; maxAgeSeconds: number; expires?: Date },
): CookieSpec {
  const spec: CookieSpec = {
    name,
    value,
    attributes: {
      httpOnly: options.httpOnly,
      secure: policy.secure,
      sameSite: policy.sameSite,
      path: policy.path,
      maxAge: options.maxAgeSeconds,
      ...(options.expires === undefined ? {} : { expires: options.expires }),
    },
  };

  assertHostPrefixSafe(spec);
  return spec;
}

/**
 * The session cookie. `HttpOnly`, so script on the page cannot read the token even if
 * an XSS foothold exists.
 *
 * Its `Max-Age` tracks the session's absolute expiry, so a browser discards it at the
 * same moment the server would refuse it. Expiry is still enforced server-side — the
 * cookie attribute is a convenience, never the control.
 */
export function sessionCookie(policy: CookiePolicy, token: string, expiresAt: Date): CookieSpec {
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1_000));
  return build(policy.sessionCookieName, token, policy, {
    httpOnly: true,
    maxAgeSeconds,
    expires: expiresAt,
  });
}

/**
 * The CSRF cookie. Deliberately **not** `HttpOnly`: the double-submit pattern
 * requires the page's own script to read it and echo it in a request header, which is
 * precisely what a cross-site request cannot do. The value is a signed random nonce
 * and carries no secret of its own (see `csrf.ts`).
 */
export function csrfCookie(policy: CookiePolicy, token: string, maxAgeSeconds: number): CookieSpec {
  return build(policy.csrfCookieName, token, policy, { httpOnly: false, maxAgeSeconds });
}

const EPOCH = new Date(0);

/** Clears a cookie: empty value, zero `Max-Age`, and an expiry in the past. */
export function clearedCookie(policy: CookiePolicy, name: string, httpOnly: boolean): CookieSpec {
  return build(name, '', policy, { httpOnly, maxAgeSeconds: 0, expires: EPOCH });
}

export function clearedSessionCookie(policy: CookiePolicy): CookieSpec {
  return clearedCookie(policy, policy.sessionCookieName, true);
}

/**
 * Renders a spec as a `Set-Cookie` header value.
 *
 * Kept here rather than taken from a framework plugin so that hook ordering in the
 * HTTP layer cannot decide whether cookies work, and so this package stays
 * framework-free. The values it handles are `base64url` and `.` only; they are still
 * percent-encoded, because a cookie value must not contain a separator and relying on
 * "our values happen to be safe" is how that stops being true later.
 */
export function serializeCookie(spec: CookieSpec): string {
  assertHostPrefixSafe(spec);

  const parts = [`${spec.name}=${encodeURIComponent(spec.value)}`];
  const { attributes } = spec;

  parts.push(`Path=${attributes.path}`);
  parts.push(`Max-Age=${String(Math.max(0, Math.floor(attributes.maxAge)))}`);

  if (attributes.expires !== undefined) {
    parts.push(`Expires=${attributes.expires.toUTCString()}`);
  }

  if (attributes.httpOnly) {
    parts.push('HttpOnly');
  }

  if (attributes.secure) {
    parts.push('Secure');
  }

  parts.push(`SameSite=${attributes.sameSite === 'lax' ? 'Lax' : 'Strict'}`);

  // No Domain attribute is ever emitted: `__Host-` forbids it, and a host-only cookie
  // is the correct default for the others too.
  return parts.join('; ');
}

/**
 * Parses a request `Cookie` header into name/value pairs.
 *
 * A malformed pair is skipped rather than throwing — a request must not be able to
 * crash the authentication hook by sending a broken header. A repeated name keeps the
 * first occurrence, so a later injected duplicate cannot override an earlier value.
 */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null) as Record<string, string>;

  if (header === undefined || header === '') {
    return cookies;
  }

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');

    if (separator < 1) {
      continue;
    }

    const name = pair.slice(0, separator).trim();
    const rawValue = pair.slice(separator + 1).trim();

    if (name === '' || name in cookies) {
      continue;
    }

    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      // Not valid percent-encoding; take the value as written rather than dropping it.
      cookies[name] = rawValue;
    }
  }

  return cookies;
}
