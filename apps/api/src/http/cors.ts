import { CSRF_HEADER_NAME } from '@organic-os/auth';
import type { Logger } from '@organic-os/observability';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Cross-origin resource sharing.
 *
 * Through Phase 0.4 there was none, because the API was reached same-origin. Cloud 0.2
 * puts the web deployment on a different host, so the policy has to be stated — and
 * stating it is the point: **CORS is not a security control here.** It tells a browser
 * which origins may *read* a response. What stops a hostile page acting as the user is
 * the signed, session-bound CSRF token (docs/SECURITY.md §2), and `SameSite=Lax`, which
 * withholds the session cookie from cross-site requests in the first place.
 *
 * Consequences of that, both deliberate:
 *
 * - **`*` is impossible**, not merely discouraged: `parseAllowedOrigins` refuses it.
 *   A wildcard cannot carry credentials, and pretending otherwise is how
 *   cookie-authenticated APIs get opened up.
 * - **An unlisted origin is not rejected on the actual request.** Its preflight is
 *   refused, and its response carries no `Access-Control-Allow-Origin`, which is
 *   exactly how a browser is told "no". Failing the request outright would break the
 *   same-origin proxy topology Cloud 0.2 runs in, where a browser's own `Origin`
 *   header arrives at the API looking cross-origin even though the browser applied no
 *   CORS at all (docs/cloud/API-STAGING.md §6). Nothing is lost: a cross-site request
 *   arrives without a session cookie, and a state-changing one is refused by CSRF.
 */

/** Methods the API actually serves. `DELETE` is absent because no route implements it. */
const ALLOWED_METHODS = 'GET, HEAD, POST, PATCH, OPTIONS';

/**
 * A fixed list rather than a reflection of `Access-Control-Request-Headers`: echoing
 * whatever was asked for turns the preflight into a formality.
 */
const ALLOWED_HEADERS = ['content-type', 'accept', CSRF_HEADER_NAME].join(', ');

/** Ten minutes. Long enough to matter, short enough that a policy change takes effect. */
const PREFLIGHT_MAX_AGE_SECONDS = '600';

/** Bound on what reaches a log line from an attacker-controlled header. */
const MAX_LOGGED_ORIGIN_LENGTH = 256;

export interface CorsPolicy {
  /**
   * Exact origins allowed to read responses, already normalised by
   * `parseAllowedOrigins`. Empty means no cross-origin browser access is granted.
   */
  readonly allowedOrigins: readonly string[];
}

export interface RegisterCorsOptions {
  readonly policy: CorsPolicy;
  readonly logger: Logger;
}

/** A repeated `Origin` is ambiguous and is treated as absent rather than guessed at. */
function readOrigin(request: FastifyRequest): string | undefined {
  const value = request.headers.origin;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function registerCors(app: FastifyInstance, options: RegisterCorsOptions): void {
  const { policy, logger } = options;
  const allowed = new Set(policy.allowedOrigins);

  app.addHook('onRequest', (request, reply, done) => {
    if (allowed.size > 0) {
      // Unconditional whenever a grant is possible, so no shared cache can serve one
      // origin's response to another.
      reply.header('vary', 'origin');
    }

    const origin = readOrigin(request);

    if (origin === undefined) {
      done();
      return;
    }

    const isPreflight =
      request.method === 'OPTIONS' &&
      typeof request.headers['access-control-request-method'] === 'string';

    if (!allowed.has(origin)) {
      logger.warn(
        {
          requestId: String(request.id),
          method: request.method,
          url: request.url,
          origin: origin.slice(0, MAX_LOGGED_ORIGIN_LENGTH),
          preflight: isPreflight,
        },
        'cross-origin request from an origin that is not allowed',
      );

      if (isPreflight) {
        reply.code(403).send();
        return reply;
      }

      done();
      return;
    }

    reply.header('access-control-allow-origin', origin).header(
      // Only ever sent alongside an exact origin, never alongside a wildcard.
      'access-control-allow-credentials',
      'true',
    );

    if (isPreflight) {
      reply
        .header('access-control-allow-methods', ALLOWED_METHODS)
        .header('access-control-allow-headers', ALLOWED_HEADERS)
        .header('access-control-max-age', PREFLIGHT_MAX_AGE_SECONDS)
        .code(204)
        .send();
      return reply;
    }

    done();
    return;
  });
}
