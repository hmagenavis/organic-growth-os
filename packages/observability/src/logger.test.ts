import { describe, expect, it } from 'vitest';

import { createLogger, type LogDestination, type Logger } from './logger.js';
import { REDACTION_CENSOR } from './redaction.js';

interface Capture {
  readonly stream: LogDestination;
  records(): Record<string, unknown>[];
  raw(): string;
}

function capture(): Capture {
  const chunks: string[] = [];

  return {
    stream: {
      write(chunk: string): void {
        chunks.push(chunk);
      },
    },
    records(): Record<string, unknown>[] {
      return chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>);
    },
    raw(): string {
      return chunks.join('');
    },
  };
}

function build(sink: Capture, level: 'info' | 'debug' = 'info'): Logger {
  return createLogger({ name: 'test-service', level }, sink.stream);
}

const SECRET = 'correct-horse-battery-staple';

describe('createLogger', () => {
  it('writes structured JSON with the service binding and level label', () => {
    const sink = capture();
    build(sink).info({ userId: 'u1' }, 'user loaded');

    const [record] = sink.records();

    expect(record).toMatchObject({
      service: 'test-service',
      level: 'info',
      msg: 'user loaded',
      userId: 'u1',
    });
  });

  it('redacts top-level sensitive fields', () => {
    const sink = capture();
    build(sink).info({ password: SECRET, token: SECRET, apiKey: SECRET }, 'credentials');

    const [record] = sink.records();

    expect(record?.['password']).toBe(REDACTION_CENSOR);
    expect(record?.['token']).toBe(REDACTION_CENSOR);
    expect(record?.['apiKey']).toBe(REDACTION_CENSOR);
    expect(sink.raw()).not.toContain(SECRET);
  });

  it('redacts nested sensitive fields', () => {
    const sink = capture();
    build(sink).info({ user: { email: 'a@example.com', password: SECRET } }, 'nested');

    expect(sink.raw()).not.toContain(SECRET);
    expect(sink.raw()).toContain('a@example.com');
  });

  it('redacts request and response header credentials', () => {
    const sink = capture();
    build(sink).info(
      {
        req: { headers: { authorization: `Bearer ${SECRET}`, cookie: `session=${SECRET}` } },
        res: { headers: { 'set-cookie': `session=${SECRET}` } },
      },
      'request',
    );

    expect(sink.raw()).not.toContain(SECRET);
  });

  it('keeps redaction on child loggers', () => {
    const sink = capture();
    const child = build(sink).child({ requestId: 'req-1' });

    child.info({ secret: SECRET }, 'child record');

    const [record] = sink.records();

    expect(record?.['requestId']).toBe('req-1');
    expect(record?.['secret']).toBe(REDACTION_CENSOR);
    expect(sink.raw()).not.toContain(SECRET);
  });

  it('suppresses records below the configured level', () => {
    const sink = capture();
    build(sink, 'info').debug({}, 'not emitted');

    expect(sink.records()).toHaveLength(0);
  });

  it('emits records at or above the configured level', () => {
    const sink = capture();
    build(sink, 'debug').debug({}, 'emitted');

    expect(sink.records()).toHaveLength(1);
  });
});
