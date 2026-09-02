import { createAuthConfig } from '@organic-os/auth';
import { serverEnv } from '@organic-os/config/server';
import {
  checkDatabaseReady,
  createAuthorizationService,
  createAuthStore,
  createClientService,
  createDatabase,
  createMemberAdministrationService,
  createMembershipStore,
  createSiteService,
  parseDatabaseEnv,
  runtimeDatabaseEnvSchema,
  describeConnection,
} from '@organic-os/database';
import { createLogger } from '@organic-os/observability';

import { buildApp } from './app.js';
import { buildAuthDependencies } from './auth/build.js';

/**
 * How long draining may take after SIGTERM before the process gives up and exits.
 * Deliberately shorter than the platform's own kill delay (Render and Railway both
 * allow 30 s), so the last thing in the logs is ours rather than a SIGKILL.
 */
const SHUTDOWN_GRACE_MS = 20_000;

async function main(): Promise<void> {
  // Fail fast: an invalid environment must stop the process before it serves traffic.
  // Authentication configuration is validated here too, so a production deployment
  // with insecure cookie settings never reaches the listen call.
  const env = serverEnv();
  const authConfig = createAuthConfig(process.env);
  const databaseEnv = parseDatabaseEnv(runtimeDatabaseEnvSchema);

  const logger = createLogger({
    name: 'api',
    level: env.LOG_LEVEL,
    bindings: { version: env.SERVICE_VERSION },
  });

  // The runtime role: constrained by Row Level Security, unable to create
  // organizations or users. The provisioning and migration connections are not opened
  // by this process at all (docs/SECURITY.md §5).
  const database = createDatabase({
    connectionString: databaseEnv.DATABASE_URL,
    maxConnections: databaseEnv.DATABASE_MAX_CONNECTIONS,
    statementTimeoutMs: databaseEnv.DATABASE_STATEMENT_TIMEOUT_MS,
    idleTransactionTimeoutMs: databaseEnv.DATABASE_IDLE_TX_TIMEOUT_MS,
    applicationName: 'organic-os-api',
  });

  logger.info(
    describeConnection(databaseEnv.DATABASE_URL),
    'database pool opened for the runtime role',
  );

  // The trust boundary and the cross-origin grant decide who `request.ip` belongs to
  // and who may read a response, so both are stated at startup rather than inferred
  // from a dashboard. Neither value is a secret: a hop count and a list of origins.
  logger.info(
    {
      trustProxy: env.API_TRUST_PROXY,
      corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS,
    },
    'http edge configuration',
  );

  if (authConfig.nodeEnv === 'production') {
    // An in-memory limiter behind more than one instance is per-instance protection.
    // Say so once, loudly, rather than letting a dashboard imply otherwise.
    logger.warn(
      { distributed: false },
      'login rate limiting is single-process until sub-phase 0.5 introduces a shared store',
    );
  }

  // Authorization is per-request and uncached: the membership store is a thin
  // wrapper over the same runtime pool, holding no state between requests, so a
  // membership or role change takes effect on the next call (docs/SECURITY.md §3).
  const authorization = createAuthorizationService({
    db: database.db,
    store: createMembershipStore(database.db),
  });

  const app = buildApp({
    logger,
    serviceVersion: env.SERVICE_VERSION,
    startedAt: Date.now(),
    auth: buildAuthDependencies({
      store: createAuthStore(database.db),
      config: authConfig,
    }),
    authorization,
    // Member administration runs on the same runtime pool and the same authorized
    // transaction. It is still the runtime role: it can mutate memberships of an
    // organization the caller administers and revoke sessions, and it cannot create
    // an organization or a user — those need the provisioning role, which this
    // process never opens a connection with (docs/SECURITY.md §5).
    memberAdministration: createMemberAdministrationService({
      authorization,
      db: database.db,
    }),
    // The client API needs no pool of its own: every one of its operations runs
    // inside `withAuthorizedOrganization`, which owns the transaction and the tenant
    // context.
    clients: createClientService({ authorization }),
    // Sites, authorized through their parent client. Like the client service it needs
    // no pool of its own: every operation runs inside `withAuthorizedOrganization`,
    // which owns the transaction and the tenant context — and which is what makes a
    // site and its initial `site_settings` row one commit.
    sites: createSiteService({ authorization }),
    // Readiness, not liveness: a database outage must stop traffic being routed here
    // without the platform restarting a process that is otherwise fine.
    checkReady: () => checkDatabaseReady(database.db),
    // Empty unless the deployment names origins. A same-origin topology needs none,
    // and an absent value must never become a permissive one.
    cors: { allowedOrigins: env.CORS_ALLOWED_ORIGINS },
    trustProxy: env.API_TRUST_PROXY,
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'shutdown requested');

    // The platform sends SIGTERM and then kills the process a fixed time later. Draining
    // must therefore be bounded by *us*, or a stuck in-flight request turns a rolling
    // deploy into a hard kill with the pool still open.
    const forceExit = setTimeout(() => {
      logger.error({ signal, graceMs: SHUTDOWN_GRACE_MS }, 'shutdown did not finish in time');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);

    forceExit.unref();

    void app
      .close()
      .then(async () => {
        await database.close();
        clearTimeout(forceExit);
        logger.info({ signal }, 'shutdown complete');
      })
      .catch((error: unknown) => {
        clearTimeout(forceExit);
        logger.error(
          { signal, errorMessage: error instanceof Error ? error.message : 'unknown error' },
          'shutdown failed',
        );
        process.exitCode = 1;
      });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  logger.info({ host: env.API_HOST, port: env.API_PORT }, 'api listening');
}

void main().catch((error: unknown) => {
  // The logger may not exist yet (configuration itself can be what failed), so report
  // to stderr. Only the message is written — never the environment that produced it.
  const message = error instanceof Error ? error.message : 'unknown error';
  process.stderr.write(`api failed to start: ${message}\n`);
  process.exitCode = 1;
});
