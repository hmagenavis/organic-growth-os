import {
  clearedSessionCookie,
  csrfCookie,
  CSRF_HEADER_NAME,
  sessionCookie,
  type AuthUserRecord,
} from '@organic-os/auth';
import {
  loginRequestSchema,
  type CsrfTokenResponse,
  type CurrentUser,
  type LoginResponse,
} from '@organic-os/contracts';
import type { Logger } from '@organic-os/observability';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthDependencies } from './context.js';
import { applyCookie, issueCsrfTokenFor } from './plugin.js';
import {
  authenticationRequired,
  invalidCredentials,
  invalidRequestBody,
  tooManyLoginAttempts,
} from './problems.js';

/**
 * The minimum legitimate authentication API: prove a credential, end a session, and
 * report who the caller is.
 *
 * There is no sign-up, no organization creation, no invitation and no password reset
 * here. Creating an organization requires the provisioning role, which the API
 * process does not hold at all — see PHASE-0.3-IMPLEMENTATION.md §"Provisioning
 * boundary".
 */

/** Lifetime of a CSRF cookie. Independent of the session; a client can always refetch. */
const CSRF_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;

function toCurrentUser(user: AuthUserRecord): CurrentUser {
  // Explicit projection, not a spread: `passwordHash` and `isPlatformAdmin` are on
  // the source object and must never reach a response body.
  return { id: user.id, email: user.email, name: user.name, locale: user.locale };
}

/**
 * Key the login rate limiter counts against.
 *
 * `request.ip` is the socket peer because the app is built with `trustProxy: false`,
 * so it cannot be forged with an `X-Forwarded-For` header. A deployment behind a
 * proxy must configure `trustProxy` explicitly rather than trusting the header by
 * default (docs/SECURITY.md §8).
 */
function sourceKeyOf(request: FastifyRequest): string {
  return request.ip;
}

function sessionMetadata(request: FastifyRequest): { ip: string; userAgent: string | undefined } {
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 512) : undefined,
  };
}

/** Issues a fresh CSRF cookie for the request's current binding and returns the token. */
function rotateCsrfCookie(
  deps: AuthDependencies,
  request: FastifyRequest,
  reply: FastifyReply,
): string {
  const token = issueCsrfTokenFor(deps, request);
  applyCookie(reply, csrfCookie(deps.config.cookies, token, CSRF_COOKIE_MAX_AGE_SECONDS));
  return token;
}

export interface RegisterAuthRoutesOptions {
  readonly deps: AuthDependencies;
  readonly logger: Logger;
}

export function registerAuthRoutes(app: FastifyInstance, options: RegisterAuthRoutesOptions): void {
  const { deps, logger } = options;

  /**
   * Bootstraps a CSRF token. Safe method, so it is not itself CSRF-checked; it hands
   * out a token bound to whatever the caller currently is (anonymous before login).
   */
  app.get('/auth/csrf', (request, reply) => {
    const body: CsrfTokenResponse = {
      csrfToken: rotateCsrfCookie(deps, request, reply),
      headerName: CSRF_HEADER_NAME,
    };

    reply.header('cache-control', 'no-store').code(200).send(body);
  });

  app.post('/auth/login', async (request, reply) => {
    const parsed = loginRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      // Only the fact of invalidity is reported and logged — never the body, which
      // contains a password.
      logger.info(
        { requestId: String(request.id), outcome: 'invalid_body' },
        'login attempt rejected',
      );
      invalidRequestBody(request, reply);
      return reply;
    }

    const result = await deps.logins.login({
      email: parsed.data.email,
      password: parsed.data.password,
      sourceKey: sourceKeyOf(request),
      existingSessionToken: request.auth.presentedToken,
      metadata: sessionMetadata(request),
    });

    if (!result.ok) {
      logger.warn(
        {
          requestId: String(request.id),
          outcome: 'failure',
          // Coarse category only. No address, no password, no hash.
          reason: result.reason,
          sourceKey: sourceKeyOf(request),
        },
        'login attempt failed',
      );

      if (result.reason === 'rate_limited') {
        tooManyLoginAttempts(request, reply, result.retryAfterSeconds ?? 60);
        return reply;
      }

      invalidCredentials(request, reply);
      return reply;
    }

    applyCookie(
      reply,
      sessionCookie(deps.config.cookies, result.session.token, result.session.session.expiresAt),
    );

    // The binding changed with the new session, so the CSRF token is reissued against
    // it. A token minted for the pre-login (anonymous) binding stops being accepted.
    request.auth = {
      identity: { user: result.user, session: result.session.session },
      failure: null,
      presentedToken: result.session.token,
    };

    const body: LoginResponse = {
      user: toCurrentUser(result.user),
      csrfToken: rotateCsrfCookie(deps, request, reply),
    };

    logger.info(
      {
        requestId: String(request.id),
        outcome: 'success',
        userId: result.user.id,
        sessionId: result.session.session.id,
      },
      'login succeeded',
    );

    reply.header('cache-control', 'no-store').code(200).send(body);
    return reply;
  });

  /**
   * Logout. Idempotent: revoking an already-dead or absent session is a success, and
   * the cookie is cleared either way.
   */
  app.post('/auth/logout', async (request, reply) => {
    const revoked = await deps.sessions.revokeByToken(request.auth.presentedToken);

    applyCookie(reply, clearedSessionCookie(deps.config.cookies));

    // The caller is anonymous from here on, so the CSRF token is rebound accordingly.
    request.auth = { identity: null, failure: null, presentedToken: undefined };
    rotateCsrfCookie(deps, request, reply);

    logger.info(
      { requestId: String(request.id), revoked },
      revoked ? 'session revoked by logout' : 'logout with no live session',
    );

    reply.header('cache-control', 'no-store').code(204).send();
    return reply;
  });

  /**
   * Proof of authentication.
   *
   * Identity fields only. It does not report organizations, memberships, roles or
   * `is_platform_admin` — turning this into the permissions endpoint is exactly what
   * sub-phase 0.4 is for.
   */
  app.get('/auth/me', (request, reply) => {
    const identity = request.auth.identity;

    if (identity === null) {
      authenticationRequired(request, reply);
      return;
    }

    const body: CurrentUser = toCurrentUser(identity.user);
    reply.header('cache-control', 'no-store').code(200).send(body);
  });
}
