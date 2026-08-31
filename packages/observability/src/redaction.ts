/**
 * Redaction is applied at the serializer level, so a secret cannot reach a log sink
 * even when a caller passes an object containing one (docs/SECURITY.md §5).
 *
 * Redaction is a safety net, not a licence to log sensitive objects: callers should
 * still log identifiers rather than payloads.
 */

export const REDACTION_CENSOR = '[REDACTED]';

/**
 * Paths censored on every logger by default.
 *
 * Covers the field name at the top level, at any single level of nesting (`*.x`), and
 * the HTTP header locations used by request/response logging.
 *
 * The authentication entries exist because Phase 0.3 introduced values that must
 * never appear in a log line under any circumstances: passwords, raw session tokens,
 * their stored hashes, CSRF tokens, and whole `Cookie` / `Set-Cookie` headers (which
 * carry the session token verbatim).
 */
export const DEFAULT_REDACT_PATHS: readonly string[] = [
  'password',
  'currentPassword',
  'newPassword',
  'confirmPassword',
  'passwordHash',
  'token',
  'sessionToken',
  'tokenHash',
  'csrfToken',
  'accessToken',
  'refreshToken',
  'secret',
  'sessionSecret',
  'clientSecret',
  'apiKey',
  'authorization',
  'cookie',
  'cookies',
  'setCookie',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.confirmPassword',
  '*.passwordHash',
  '*.token',
  '*.sessionToken',
  '*.tokenHash',
  '*.csrfToken',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.sessionSecret',
  '*.clientSecret',
  '*.apiKey',
  '*.authorization',
  '*.cookie',
  '*.cookies',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
];
