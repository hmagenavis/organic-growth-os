import type { HealthResponse, ReadinessResponse } from '@organic-os/contracts';
import type { Logger } from '@organic-os/observability';
import type { FastifyInstance } from 'fastify';

export interface HealthRouteOptions {
  serviceVersion: string;
  /** Epoch milliseconds at process start, used to report uptime. */
  startedAt: number;
  /**
   * Dependency probe for `/health/ready`. Returns true when the service can actually
   * serve traffic. Optional: a deployment that serves only `/health` (and the
   * health-only unit tests) needs no database.
   *
   * It must resolve rather than throw — the reason for a failure belongs in the logs,
   * never in a response (docs/SECURITY.md §8).
   */
  checkReady?: () => Promise<boolean>;
  logger?: Logger;
}

/**
 * Liveness and readiness.
 *
 * `/health` answers "is this process running" — it never touches a dependency, so a
 * database outage does not make the platform restart otherwise-healthy processes.
 *
 * `/health/ready` answers "can this process serve traffic". It reports a bare
 * ready/not_ready and nothing else: which dependency is down, why, and what the
 * connection error said are all topology, and this endpoint is reachable by anyone who
 * can reach the service. The detail goes to the structured log with the request id.
 */
export function registerHealthRoute(app: FastifyInstance, options: HealthRouteOptions): void {
  const { serviceVersion, startedAt, checkReady, logger } = options;

  app.get('/health', (_request, reply) => {
    const body: HealthResponse = {
      status: 'ok',
      service: 'api',
      version: serviceVersion,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
    };

    reply.header('cache-control', 'no-store').code(200).send(body);
  });

  app.get('/health/ready', async (request, reply) => {
    const ready = checkReady === undefined ? true : await checkReady();

    if (!ready) {
      logger?.warn(
        { requestId: String(request.id), dependency: 'database' },
        'readiness probe reported the service cannot serve traffic',
      );
    }

    const body: ReadinessResponse = {
      status: ready ? 'ready' : 'not_ready',
      service: 'api',
      version: serviceVersion,
    };

    // 503 so a load balancer stops routing without the platform restarting a process
    // that is otherwise healthy.
    reply
      .header('cache-control', 'no-store')
      .code(ready ? 200 : 503)
      .send(body);

    return reply;
  });
}
