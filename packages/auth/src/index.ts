/**
 * Authentication primitives.
 *
 * This package answers exactly one question — *who is this user and is this session
 * authentic?* — and deliberately answers no other. It contains no HTTP handling, no
 * UI, no SQL, and no authorization: what an authenticated identity is *allowed* to do
 * (organization membership, roles, tenant context) belongs to sub-phase 0.4 and is
 * not inferable from anything exported here.
 */

export {
  authEnvSchema,
  createAuthConfig,
  DEVELOPMENT_CSRF_COOKIE_NAME,
  DEVELOPMENT_SESSION_COOKIE_NAME,
  PRODUCTION_CSRF_COOKIE_NAME,
  PRODUCTION_SESSION_COOKIE_NAME,
  type AuthConfig,
  type AuthEnv,
  type CookiePolicy,
} from './config.js';

export {
  assertHostPrefixSafe,
  clearedCookie,
  clearedSessionCookie,
  csrfCookie,
  HOST_COOKIE_PREFIX,
  InvalidCookieSpecError,
  parseCookieHeader,
  serializeCookie,
  sessionCookie,
  type CookieAttributes,
  type CookieSpec,
} from './cookies.js';

export {
  ANONYMOUS_CSRF_BINDING,
  CSRF_HEADER_NAME,
  isStateChangingMethod,
  issueCsrfToken,
  verifyCsrfToken,
  type CsrfVerdict,
  type VerifyCsrfInput,
} from './csrf.js';

export { AuthConfigError, InvalidPasswordInputError, type AuthFailureReason } from './errors.js';

export {
  checkPasswordPolicy,
  createPasswordHasher,
  DEFAULT_PASSWORD_HASH_PARAMETERS,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  type PasswordHasher,
  type PasswordHashParameters,
  type PasswordPolicyResult,
} from './password.js';

export {
  accountRateLimitKey,
  createLoginRateLimiter,
  sourceRateLimitKey,
  type LoginRateLimiter,
  type LoginRateLimiterOptions,
  type RateLimitVerdict,
} from './rate-limit/login-limiter.js';
export { InMemoryRateLimitStore } from './rate-limit/memory.js';
export type { RateLimitHit, RateLimitStore } from './rate-limit/store.js';

export {
  createLoginService,
  normalizeEmail,
  type LoginRequest,
  type LoginResult,
  type LoginService,
  type LoginServiceOptions,
} from './login-service.js';

export {
  createSessionService,
  type AuthenticatedIdentity,
  type IssuedSession,
  type SessionMetadata,
  type SessionResolution,
  type SessionService,
  type SessionServiceOptions,
} from './session-service.js';

export {
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
  secretEquals,
  SESSION_TOKEN_BYTES,
  SESSION_TOKEN_LENGTH,
} from './tokens.js';

export type {
  AuthStore,
  AuthUserRecord,
  CreateSessionInput,
  ResolvedSession,
  SessionRecord,
} from './store.js';
