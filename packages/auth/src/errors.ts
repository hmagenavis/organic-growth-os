/**
 * Authentication errors.
 *
 * None of these ever carry a credential, a token, a hash or a database message: they
 * are thrown on paths whose messages reach logs, and the external representation is
 * the generic problem+json produced by the API (docs/SECURITY.md §8).
 */

/**
 * Why an authentication attempt failed. Coarse on purpose — it is a log/metric
 * category, never something an unauthenticated caller is told.
 */
export type AuthFailureReason =
  | 'unknown_user'
  | 'no_credential'
  | 'bad_password'
  | 'rate_limited'
  | 'no_session_cookie'
  | 'session_not_found'
  | 'session_revoked'
  | 'session_expired'
  | 'session_idle_expired';

/** Configuration that would make authentication insecure. Thrown at startup only. */
export class AuthConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid authentication configuration: ${issues.join(', ')}`);
    this.name = 'AuthConfigError';
    this.issues = issues;
  }
}

/** A password that cannot be hashed at all (absent, empty, or absurdly long). */
export class InvalidPasswordInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPasswordInputError';
  }
}
