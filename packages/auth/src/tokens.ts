import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Session token generation and hashing.
 *
 * The browser receives an opaque random string; the database receives only its
 * SHA-256 digest. A stolen database therefore yields no usable session token
 * (ADR-0013, docs/SECURITY.md §2).
 *
 * SHA-256 is the right primitive here — unlike a password, the token already carries
 * full 256-bit entropy, so there is nothing for a slow KDF to defend against.
 */

/** 32 bytes = 256 bits of entropy, per ADR-0013. */
export const SESSION_TOKEN_BYTES = 32;

/** Length of the base64url encoding of `SESSION_TOKEN_BYTES` (no padding). */
export const SESSION_TOKEN_LENGTH = 43;

/** Generates an opaque session token from the platform CSPRNG. */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/** Digest stored in `sessions.token_hash`. The raw token is never persisted. */
export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Rejects tokens that cannot have come from `generateSessionToken`, so a malformed
 * cookie never reaches the database as a query parameter.
 */
export function isWellFormedSessionToken(token: string): boolean {
  return token.length === SESSION_TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(token);
}

/**
 * Timing-safe comparison of two secret-derived strings.
 *
 * `timingSafeEqual` requires equal-length buffers and throws otherwise, which would
 * itself leak length; both sides are therefore digested first so the comparison is
 * always over 32 bytes.
 */
export function secretEquals(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}
