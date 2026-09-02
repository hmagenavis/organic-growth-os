import { randomUUID } from 'node:crypto';

import type { TrustProxyConfig } from '@organic-os/config/server';
import type {
  AuthorizationService,
  ClientService,
  MemberAdministrationService,
  SiteService,
} from '@organic-os/database';
import type { Logger } from '@organic-os/observability';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerAdministrationRoutes } from './administration/routes.js';
import type { AuthDependencies } from './auth/context.js';
import { registerAuthPlugin } from './auth/plugin.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerAuthorizationRoutes } from './authorization/routes.js';
import { registerClientRoutes } from './clients/routes.js';
import { registerErrorHandlers } from './errors.js';
import { registerCors, type CorsPolicy } from './http/cors.js';
import { registerSiteRoutes } from './sites/routes.js';
import { registerHealthRoute } from './routes/health.js';

export interface BuildAppOptions {
  logger: Logger;
  serviceVersion: string;
  /** Epoch milliseconds at process start. Defaults to app construction time. */
  startedAt?: number;
  /**
   * Authentication wiring. Optional so a deployment that serves only `/health` (and
   * the health-only unit tests) needs no session infrastructure; when absent, no
   * `/auth/*` route exists at all rather than an unprotected stub.
   */
  auth?: AuthDependencies;
  /**
   * Authorization wiring. Requires `auth`: an authorization route with no
   * authentication in front of it would have no identity to authorize, so the two are
   * registered together or not at all.
   */
  authorization?: AuthorizationService;
  /**
   * Member administration wiring. Requires `auth` and `authorization`, and is
   * separate from them because it is a *larger* grant: these routes mutate
   * memberships and end other people's sessions.
   *
   * A deployment that omits it serves no member-administration route at all rather
   * than an unguarded one — the same fail-closed shape as omitting `auth`.
   */
  memberAdministration?: MemberAdministrationService;
  /**
   * Client API wiring. Requires `auth` and `authorization`, and is registered
   * independently of `memberAdministration`: administering members and administering
   * clients are separate grants, and a deployment that omits this serves no client
   * route at all rather than an unguarded one.
   */
  clients?: ClientService;
  /**
   * Site API wiring. Requires `auth` and `authorization`, and is registered
   * independently of `clients`: a site is authorized through its parent client, but
   * serving the client routes and serving the site routes are separate grants, and a
   * deployment that omits this serves no site route at all rather than an unguarded
   * one.
   */
  sites?: SiteService;
  /**
   * Dependency probe backing `GET /health/ready`. Absent means the deployment has no
   * dependency to be ready for, and readiness reduces to liveness.
   */
  checkReady?: () => Promise<boolean>;
  /**
   * Cross-origin policy. Absent means no cross-origin grant at all, which is the
   * correct value for a same-origin deployment (`./http/cors.ts`).
   */
  cors?: CorsPolicy;
  /**
   * What sits in front of this process. Defaults to `false`: `request.ip` is the
   * socket peer, so it cannot be forged with a header, which is what makes it usable
   * as the login rate-limit key and as `sessions.ip`.
   *
   * A proxied deployment must name the addresses it sits behind. `parseTrustProxy`
   * refuses both the blanket `true` and a hop count, the latter because Fastify
   * silently enforces nothing for it (docs/cloud/API-STAGING.md §5).
   */
  trustProxy?: TrustProxyConfig;
}

/**
 * Builds the API instance.
 *
 * Every cross-cutting concern is opt-in and off by default, so a deployment that does
 * not wire something serves nothing for it rather than an unguarded version: no
 * `auth` means no `/auth/*` route, no `cors` means no cross-origin grant, and no
 * `trustProxy` means `request.ip` is the socket peer (docs/ADR/0013,
 * docs/SECURITY.md §8).
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const {
    logger,
    serviceVersion,
    startedAt = Date.now(),
    auth,
    authorization,
    memberAdministration,
    clients,
    sites,
    checkReady,
    cors,
    trustProxy = false,
  } = options;

  const app = Fastify({
    // Request logging is emitted explicitly below so the logged fields stay controlled
    // and pass through the redacting logger.
    logger: false,
    genReqId: () => randomUUID(),
    // The socket peer unless the deployment names the proxies in front of it.
    // `x-forwarded-for` is believed only as far as that boundary reaches, because
    // `request.ip` is the login rate-limit key and the address recorded on every
    // session. The list is passed in Fastify's comma-separated string form; Fastify
    // enforces an address list and silently ignores a hop count, which is why
    // `parseTrustProxy` refuses one.
    trustProxy: trustProxy === false ? false : trustProxy.join(','),
    bodyLimit: 1_048_576,
  });

  app.addHook('onRequest', (_request, reply, done) => {
    reply.header('x-content-type-options', 'nosniff');
    done();
  });

  // Before authentication: a preflight is answered without resolving a session, and
  // an unlisted origin is refused before any dependency is touched.
  if (cors !== undefined) {
    registerCors(app, { policy: cors, logger });
  }

  app.addHook('onResponse', (request, reply, done) => {
    logger.info(
      {
        requestId: String(request.id),
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        // The address as resolved through the configured trust boundary. It is what
        // the login rate limiter counts against, so a security log that omitted it
        // could not be used to check the boundary is the one that was intended.
        ip: request.ip,
      },
      'request completed',
    );
    done();
  });

  registerErrorHandlers(app, logger);
  registerHealthRoute(app, {
    serviceVersion,
    startedAt,
    logger,
    ...(checkReady === undefined ? {} : { checkReady }),
  });

  if (auth !== undefined) {
    registerAuthPlugin(app, { deps: auth, logger });
    registerAuthRoutes(app, { deps: auth, logger });

    if (authorization !== undefined) {
      registerAuthorizationRoutes(app, { service: authorization, logger });

      if (memberAdministration !== undefined) {
        registerAdministrationRoutes(app, { members: memberAdministration, logger });
      }

      if (clients !== undefined) {
        registerClientRoutes(app, { clients, logger });
      }

      if (sites !== undefined) {
        registerSiteRoutes(app, { sites, logger });
      }
    }
  }

  return app;
}
