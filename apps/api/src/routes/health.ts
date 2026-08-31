import type { HealthResponse } from '@organic-os/contracts';
import type { FastifyInstance } from 'fastify';

export interface HealthRouteOptions {
  serviceVersion: string;
  /** Epoch milliseconds at process start, used to report uptime. */
  startedAt: number;
}

/**
 * Liveness endpoint. Reports only what an unauthenticated caller may see: that the
 * process is up, which service it is, and its version.
 */
export function registerHealthRoute(app: FastifyInstance, options: HealthRouteOptions): void {
  app.get('/health', (_request, reply) => {
    const body: HealthResponse = {
      status: 'ok',
      service: 'api',
      version: options.serviceVersion,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - options.startedAt) / 1000)),
    };

    reply.header('cache-control', 'no-store').code(200).send(body);
  });
}
