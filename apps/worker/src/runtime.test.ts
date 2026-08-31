import { createLogger, type LogDestination, type Logger } from '@organic-os/observability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkerRuntime } from './runtime.js';

interface Capture {
  readonly stream: LogDestination;
  messages(): string[];
}

function capture(): Capture {
  const chunks: string[] = [];

  return {
    stream: {
      write(chunk: string): void {
        chunks.push(chunk);
      },
    },
    messages(): string[] {
      return chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line): string => {
          const record = JSON.parse(line) as { msg?: unknown };
          return typeof record.msg === 'string' ? record.msg : '';
        });
    },
  };
}

function loggerFor(sink: Capture): Logger {
  return createLogger({ name: 'worker-test', level: 'debug' }, sink.stream);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createWorkerRuntime', () => {
  it('is not running before start', () => {
    const runtime = createWorkerRuntime({
      logger: loggerFor(capture()),
      heartbeatIntervalMs: 1000,
    });

    expect(runtime.running).toBe(false);
  });

  it('reports that no processors are registered on startup', () => {
    const sink = capture();
    const runtime = createWorkerRuntime({ logger: loggerFor(sink), heartbeatIntervalMs: 1000 });

    runtime.start();

    expect(runtime.running).toBe(true);
    expect(sink.messages()).toContain('worker started; no job processors are registered yet');
  });

  it('ignores a repeated start instead of stacking heartbeats', () => {
    const sink = capture();
    const runtime = createWorkerRuntime({ logger: loggerFor(sink), heartbeatIntervalMs: 1000 });

    runtime.start();
    runtime.start();
    vi.advanceTimersByTime(1000);

    const heartbeats = sink.messages().filter((message) => message === 'worker heartbeat');
    expect(heartbeats).toHaveLength(1);
  });

  it('emits a heartbeat on the configured interval', () => {
    const sink = capture();
    const runtime = createWorkerRuntime({ logger: loggerFor(sink), heartbeatIntervalMs: 1000 });

    runtime.start();
    vi.advanceTimersByTime(3000);

    const heartbeats = sink.messages().filter((message) => message === 'worker heartbeat');
    expect(heartbeats).toHaveLength(3);
  });

  it('stops cleanly and emits no further heartbeats', async () => {
    const sink = capture();
    const runtime = createWorkerRuntime({ logger: loggerFor(sink), heartbeatIntervalMs: 1000 });

    runtime.start();
    await runtime.stop();
    vi.advanceTimersByTime(5000);

    expect(runtime.running).toBe(false);
    expect(sink.messages()).toContain('worker stopped');
    expect(sink.messages().filter((message) => message === 'worker heartbeat')).toHaveLength(0);
  });

  it('tolerates stop before start', async () => {
    const runtime = createWorkerRuntime({
      logger: loggerFor(capture()),
      heartbeatIntervalMs: 1000,
    });

    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(runtime.running).toBe(false);
  });
});
