import { parseTrustProxy, type TrustProxyConfig } from '@organic-os/config/server';
import { createLogger } from '@organic-os/observability';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';

/**
 * `request.ip` is the login rate-limit key and the address written to `sessions.ip`,
 * so what the process believes about `x-forwarded-for` is a security setting rather
 * than a convenience. These tests pin the behaviour at each boundary, and one of them
 * pins a Fastify behaviour we do not control (`a hop count`).
 *
 * The address is read back through a route registered for the test rather than through
 * a production endpoint: no deployed route reports the caller's address, and none
 * should.
 */

let app: FastifyInstance | undefined;

/** Stands in for the platform's internal load balancer: private address space. */
const EDGE = '10.11.12.13';
/** Stands in for the browser, as the platform's edge observed it. */
const CLIENT = '203.0.113.7';

function createApp(trustProxy?: TrustProxyConfig): FastifyInstance {
  const instance = buildApp({
    logger: createLogger({ name: 'trust-proxy-test', level: 'silent' }),
    serviceVersion: '1.2.3-test',
    ...(trustProxy === undefined ? {} : { trustProxy }),
  });

  instance.get('/test/ip', (request, reply) => {
    reply.send({ ip: request.ip });
  });

  app = instance;
  return instance;
}

async function ipSeenBy(
  instance: FastifyInstance,
  forwardedFor: string,
  remoteAddress = EDGE,
): Promise<string> {
  const response = await instance.inject({
    method: 'GET',
    url: '/test/ip',
    remoteAddress,
    headers: { 'x-forwarded-for': forwardedFor },
  });

  return response.json<{ ip: string }>().ip;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('the default boundary', () => {
  it('ignores x-forwarded-for entirely', async () => {
    expect(await ipSeenBy(createApp(), CLIENT)).toBe(EDGE);
  });

  it('is the same whether the option is omitted or explicitly false', async () => {
    expect(await ipSeenBy(createApp(false), CLIENT)).toBe(EDGE);
  });
});

describe('a named peer', () => {
  it('trusts the proxy that is actually in front and reports the real client', async () => {
    expect(await ipSeenBy(createApp(['uniquelocal']), CLIENT)).toBe(CLIENT);
    expect(await ipSeenBy(createApp([EDGE]), CLIENT)).toBe(CLIENT);
    expect(await ipSeenBy(createApp(['10.0.0.0/8']), CLIENT)).toBe(CLIENT);
  });

  it('trusts nobody else, so a different peer gets no forwarding at all', async () => {
    expect(await ipSeenBy(createApp(['192.0.2.1']), CLIENT)).toBe(EDGE);
  });

  it('is not fooled by a client that forges its own x-forwarded-for entry', async () => {
    // The platform's edge appends what it saw, so the forged entry sits to the left of
    // the real address. Walking from the socket inwards stops at the first untrusted
    // address, which is the real client — the forgery is never reached.
    expect(await ipSeenBy(createApp(['uniquelocal']), `1.2.3.4, ${CLIENT}`)).toBe(CLIENT);
  });

  it('cannot be pushed further by a client that forges a private-range chain', async () => {
    // Private-range entries in the header are trusted as hops, but the address that
    // ends up reported is still one the client supplied — which is why this boundary
    // is only sound while the peer itself cannot be an arbitrary internet host.
    const seen = await ipSeenBy(createApp(['uniquelocal']), `${CLIENT}, 10.0.0.9`);
    expect(seen).toBe(CLIENT);
  });
});

describe('a hop count', () => {
  it('is refused at configuration time, because Fastify would enforce nothing', () => {
    // fastify@5.12.1 `getTrustProxyFn` maps a number to a function that trusts
    // nothing. Accepting one here would produce a deployment that reads as configured
    // and behaves as `false`.
    expect(() => parseTrustProxy('1')).toThrow(/hop count/);
  });
});
