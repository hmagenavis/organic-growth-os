import { randomUUID } from 'node:crypto';

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
}

/**
 * Builds the API instance.
 *
 * No CORS is configured: the dashboard is served same-origin or through an explicit
 * gateway, and a permissive cross-origin policy would undermine cookie-based sessions
 * (docs/ADR/0013, docs/SECURITY.md §8).
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
  } = options;

  const app = Fastify({
    // Request logging is emitted explicitly below so the logged fields stay controlled
    // and pass through the redacting logger.
    logger: false,
    genReqId: () => randomUUID(),
    // The socket peer is the only address we trust. A proxied deployment must opt in
    // explicitly; until then `request.ip` cannot be forged with a header, which is
    // what makes it usable as a rate-limit key.
    trustProxy: false,
    bodyLimit: 1_048_576,
  });

  app.addHook('onRequest', (_request, reply, done) => {
    reply.header('x-content-type-options', 'nosniff');
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    logger.info(
      {
        requestId: String(request.id),
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
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
