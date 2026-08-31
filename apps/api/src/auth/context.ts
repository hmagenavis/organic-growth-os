import type {
  AuthConfig,
  AuthenticatedIdentity,
  AuthFailureReason,
  LoginService,
  SessionService,
} from '@organic-os/auth';
import type { LoginRateLimiter } from '@organic-os/auth';

/**
 * Authentication wiring for the HTTP layer.
 *
 * The API composes services built in `@organic-os/auth`; it holds no cryptography,
 * no lifetime policy and no SQL of its own.
 */
export interface AuthDependencies {
  readonly config: AuthConfig;
  readonly sessions: SessionService;
  readonly logins: LoginService;
  readonly rateLimiter: LoginRateLimiter;
}

/**
 * What a request knows about its caller once authentication has run.
 *
 * Note what is *absent*: no organization, no role, no client scope, no tenant
 * context. Authentication answers "who is this and is the session authentic"; it
 * never implies authorization to act inside any organization. Deriving a
 * `TenantContext` is deliberately not possible from this object — that step belongs
 * to sub-phase 0.4 (docs/SECURITY.md §3–§4).
 */
export interface RequestAuthentication {
  readonly identity: AuthenticatedIdentity | null;
  /** Why authentication did not succeed. For logs and metrics only. */
  readonly failure: AuthFailureReason | null;
  /** Raw session token from the cookie, needed by login rotation and logout. */
  readonly presentedToken: string | undefined;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by the authentication hook on every request. */
    auth: RequestAuthentication;
  }
}

export const UNAUTHENTICATED: RequestAuthentication = {
  identity: null,
  failure: null,
  presentedToken: undefined,
};
