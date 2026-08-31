import type { Logger } from '@organic-os/observability';

export interface WorkerRuntimeOptions {
  logger: Logger;
  heartbeatIntervalMs: number;
}

export interface WorkerRuntime {
  readonly running: boolean;
  start(): void;
  stop(): Promise<void>;
}

/**
 * Worker process lifecycle: start, periodic liveness signal, graceful stop.
 *
 * This process consumes no queues yet — the BullMQ queue registry and job processors
 * arrive in Phase 0.5 (docs/phases/PHASE-0.md §0.5). The startup record states the
 * registered processor count explicitly so an idle worker is never mistaken for a
 * working one.
 */
export function createWorkerRuntime(options: WorkerRuntimeOptions): WorkerRuntime {
  const { logger, heartbeatIntervalMs } = options;

  let heartbeat: NodeJS.Timeout | undefined;

  return {
    get running(): boolean {
      return heartbeat !== undefined;
    },

    start(): void {
      if (heartbeat !== undefined) {
        return;
      }

      heartbeat = setInterval(() => {
        logger.debug({}, 'worker heartbeat');
      }, heartbeatIntervalMs);

      logger.info(
        { heartbeatIntervalMs, registeredProcessors: 0 },
        'worker started; no job processors are registered yet',
      );
    },

    stop(): Promise<void> {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }

      logger.info({}, 'worker stopped');
      return Promise.resolve();
    },
  };
}
