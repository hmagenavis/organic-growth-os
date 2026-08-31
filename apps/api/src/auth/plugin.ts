import {
  ANONYMOUS_CSRF_BINDING,
  CSRF_HEADER_NAME,
  isStateChangingMethod,
  issueCsrfToken,
  parseCookieHeader,
  serializeCookie,
  verifyCsrfToken,
  type CookieSpec,
} from '@organic-os/auth';
import type { Logger } from '@organic-os/observability';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { UNAUTHENTICATED, type AuthDependencies, type RequestAuthentication } from './context.js';
import { csrfRejected } from './problems.js';

/**
 * Request-level authentication and CSRF enforcement.
 *
 * Order matters and is fixed here:
 *
 *   1. resolve the session, so the CSRF check knows the binding to verify against;
 *   2. enforce CSRF on every state-changing method, including login and logout.
 *
 * Login is not exempt. A login CSRF is a real attack — it signs a victim into the
 * attacker's account — and the anonymous-bound token from `GET /auth/csrf` makes
 * protecting it free.
 *
 * Cookie reading and writing use the framework-free helpers from `@organic-os/auth`
 * rather than a plugin, so plugin load order can never decide whether the session
 * cookie is visible to these hooks.
 */

/** Appends a `Set-Cookie` header. Fastify accumulates repeated values into a list. */
export function applyCookie(reply: FastifyReply, spec: CookieSpec): void {
  reply.header('set-cookie', serializeCookie(spec));
}

export function readCookies(request: FastifyRequest): Record<string, string> {
  return parseCookieHeader(request.headers.cookie);
}

/** The value a CSRF token must be bound to for this request. */
export function csrfBinding(request: FastifyRequest): string {
  return request.auth.identity?.session.id ?? ANONYMOUS_CSRF_BINDING;
}

export function issueCsrfTokenFor(deps: AuthDependencies, request: FastifyRequest): string {
  return issueCsrfToken(deps.config.sessionSecret, csrfBinding(request));
}

/**
 * The reusable authentication primitive.
 *
 * Parses the session cookie, hashes the token, resolves the server-side session and
 * loads the user. It returns identity only — never an organization, never a role,
 * never a tenant context (docs/SECURITY.md §3–§4).
 */
export async function authenticateRequest(
  deps: AuthDependencies,
  request: FastifyRequest,
): Promise<void> {
  const presentedToken = readCookies(request)[deps.config.cookies.sessionCookieName];

  if (presentedToken === undefined || presentedToken === '') {
    request.auth = { ...UNAUTHENTICATED, failure: 'no_session_cookie' };
    return;
  }

  const resolution = await deps.sessions.resolveSession(presentedToken);

  request.auth = resolution.ok
    ? { identity: resolution.identity, failure: null, presentedToken }
    : { identity: null, failure: resolution.reason, presentedToken };
}

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];

  // A repeated header is ambiguous and is treated as absent rather than guessed at.
  return typeof value === 'string' ? value : undefined;
}

export interface RegisterAuthPluginOptions {
  readonly deps: AuthDependencies;
  readonly logger: Logger;
}

export function registerAuthPlugin(app: FastifyInstance, options: RegisterAuthPluginOptions): void {
  const { deps, logger } = options;

  // Per-request state is held in a WeakMap rather than assigned onto a shared
  // decorator object: Fastify v5 rejects reference-typed request decorators exactly
  // because one caller's authentication could otherwise become another's.
  const perRequest = new WeakMap<FastifyRequest, RequestAuthentication>();

  app.decorateRequest('auth', {
    getter(this: FastifyRequest): RequestAuthentication {
      // Unauthenticated is the default, so a route reached before the hook ran (there
      // is none, but the shape must fail closed) sees no identity.
      return perRequest.get(this) ?? UNAUTHENTICATED;
    },
    setter(this: FastifyRequest, value: RequestAuthentication): void {
      perRequest.set(this, value);
    },
  });

  app.addHook('onRequest', async (request) => {
    await authenticateRequest(deps, request);
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!isStateChangingMethod(request.method)) {
      return;
    }

    const verdict = verifyCsrfToken({
      secret: deps.config.sessionSecret,
      binding: csrfBinding(request),
      cookieToken: readCookies(request)[deps.config.cookies.csrfCookieName],
      requestToken: readHeader(request, CSRF_HEADER_NAME),
    });

    if (verdict === 'ok') {
      return;
    }

    // The verdict category is logged; neither token value ever is.
    logger.warn(
      {
        requestId: String(request.id),
        method: request.method,
        url: request.url,
        verdict,
        authenticated: request.auth.identity !== null,
      },
      'csrf check rejected request',
    );

    csrfRejected(request, reply);
    return reply;
  });
}
