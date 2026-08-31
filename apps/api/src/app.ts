import { randomUUID } from 'node:crypto';

import type { Logger } from '@organic-os/observability';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerErrorHandlers } from './errors.js';
import { registerHealthRoute } from './routes/health.js';

export interface BuildAppOptions {
  logger: Logger;
  serviceVersion: string;
  /** Epoch milliseconds at process start. Defaults to app construction time. */
  startedAt?: number;
}

/**
 * Builds the API instance.
 *
 * No CORS is configured: the dashboard is served same-origin or through an explicit
 * gateway, and a permissive cross-origin policy would undermine cookie-based sessions
 * (docs/ADR/0013, docs/SECURITY.md §8).
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { logger, serviceVersion, startedAt = Date.now() } = options;

  const app = Fastify({
    // Request logging is emitted explicitly below so the logged fields stay controlled
    // and pass through the redacting logger.
    logger: false,
    genReqId: () => randomUUID(),
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
  registerHealthRoute(app, { serviceVersion, startedAt });

  return app;
}
