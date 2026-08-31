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
 */
export const DEFAULT_REDACT_PATHS: readonly string[] = [
  'password',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'clientSecret',
  'apiKey',
  'authorization',
  'cookie',
  '*.password',
  '*.newPassword',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.clientSecret',
  '*.apiKey',
  '*.authorization',
  '*.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];
