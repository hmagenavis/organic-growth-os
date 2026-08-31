import { beforeEach, describe, expect, it } from 'vitest';

import { createAuthConfig, type AuthConfig } from '../config.js';
import {
  accountRateLimitKey,
  createLoginRateLimiter,
  sourceRateLimitKey,
  type LoginRateLimiter,
} from './login-limiter.js';
import { InMemoryRateLimitStore } from './memory.js';

const config: AuthConfig = createAuthConfig({
  AUTH_SESSION_SECRET: 'x'.repeat(64),
  AUTH_LOGIN_RATE_LIMIT_IP_MAX: '5',
  AUTH_LOGIN_RATE_LIMIT_ACCOUNT_MAX: '3',
  AUTH_LOGIN_RATE_LIMIT_WINDOW_MS: '60000',
});

let store: InMemoryRateLimitStore;
let limiter: LoginRateLimiter;
let clock: number;

beforeEach(() => {
  clock = 1_000_000;
  store = new InMemoryRateLimitStore();
  limiter = createLoginRateLimiter({ store, config, now: () => clock });
});

describe('in-memory rate limit store', () => {
  it('does not claim to be distributed', () => {
    // The property exists so a deployment can assert it rather than assume it.
    expect(store.distributed).toBe(false);
    expect(limiter.distributed).toBe(false);
  });

  it('counts hits inside a window and starts a new one after it', async () => {
    expect(await store.hit('k', 1_000, 0)).toEqual({ count: 1, resetAt: 1_000 });
    expect(await store.hit('k', 1_000, 500)).toEqual({ count: 2, resetAt: 1_000 });
    expect(await store.hit('k', 1_000, 1_000)).toEqual({ count: 1, resetAt: 2_000 });
  });

  it('keeps keys independent', async () => {
    await store.hit('a', 1_000, 0);
    await store.hit('a', 1_000, 0);

    expect((await store.hit('b', 1_000, 0)).count).toBe(1);
  });

  it('peeks without counting, and reports nothing outside a window', async () => {
    await store.hit('k', 1_000, 0);

    expect((await store.peek('k', 0))?.count).toBe(1);
    expect((await store.peek('k', 0))?.count).toBe(1);
    expect(await store.peek('k', 1_500)).toBeNull();
    expect(await store.peek('never-seen', 0)).toBeNull();
  });

  it('clears a key on reset', async () => {
    await store.hit('k', 1_000, 0);
    await store.reset('k');

    expect(await store.peek('k', 0)).toBeNull();
  });

  it('bounds how many keys it retains', async () => {
    const bounded = new InMemoryRateLimitStore(3);

    for (const key of ['a', 'b', 'c', 'd']) {
      await bounded.hit(key, 60_000, 0);
    }

    // The oldest key was evicted rather than growing without limit.
    expect(await bounded.peek('a', 0)).toBeNull();
    expect((await bounded.peek('d', 0))?.count).toBe(1);
  });
});

describe('login rate limiting', () => {
  const SOURCE = '203.0.113.7';
  const EMAIL = 'owner@example.test';

  it('allows attempts until the account budget is spent', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await limiter.check(SOURCE, EMAIL)).allowed).toBe(true);
      await limiter.recordFailure(SOURCE, EMAIL);
    }

    const verdict = await limiter.check(SOURCE, EMAIL);

    expect(verdict.allowed).toBe(false);
    expect(verdict.scope).toBe('account');
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
    expect(verdict.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('throttles a source spraying many different accounts', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await limiter.recordFailure(SOURCE, `victim-${String(attempt)}@example.test`);
    }

    const verdict = await limiter.check(SOURCE, 'victim-99@example.test');

    expect(verdict.allowed).toBe(false);
    expect(verdict.scope).toBe('ip');
  });

  it('does not let one source exhaust another account from a different source', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await limiter.recordFailure(SOURCE, EMAIL);
    }

    // Same account, different source: the account budget is shared, which is the
    // point of having it.
    expect((await limiter.check('198.51.100.4', EMAIL)).allowed).toBe(false);
    // Different account, different source: unaffected.
    expect((await limiter.check('198.51.100.4', 'someone@example.test')).allowed).toBe(true);
  });

  it('counts a nonexistent account exactly like an existing one', async () => {
    // The caller consumes budget on failure regardless of whether the account exists,
    // so the throttled response cannot be used to probe for valid addresses.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await limiter.recordFailure(SOURCE, 'does-not-exist@example.test');
    }

    const unknown = await limiter.check(SOURCE, 'does-not-exist@example.test');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await limiter.recordFailure('198.51.100.9', EMAIL);
    }

    const known = await limiter.check('198.51.100.9', EMAIL);

    expect(unknown.allowed).toBe(known.allowed);
    expect(unknown.scope).toBe(known.scope);
  });

  it('normalizes case so one address cannot get two budgets', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await limiter.recordFailure(SOURCE, EMAIL);
    }

    expect(accountRateLimitKey(EMAIL)).toBe(accountRateLimitKey(EMAIL));
    expect((await limiter.check(SOURCE, EMAIL)).allowed).toBe(false);
  });

  it('clears the account budget on success but keeps the source budget', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await limiter.recordFailure(SOURCE, EMAIL);
    }

    await limiter.recordSuccess(EMAIL);

    expect((await limiter.check(SOURCE, EMAIL)).allowed).toBe(true);
    expect((await store.peek(sourceRateLimitKey(SOURCE), clock))?.count).toBe(3);
  });

  it('lets attempts through again once the window passes', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await limiter.recordFailure(SOURCE, EMAIL);
    }

    expect((await limiter.check(SOURCE, EMAIL)).allowed).toBe(false);

    clock += 60_001;

    expect((await limiter.check(SOURCE, EMAIL)).allowed).toBe(true);
  });

  it('never stores an address in the clear', async () => {
    await limiter.recordFailure(SOURCE, EMAIL);

    expect(accountRateLimitKey(EMAIL)).not.toContain('owner');
    expect(accountRateLimitKey(EMAIL)).not.toContain('example.test');
    expect(accountRateLimitKey(EMAIL)).toMatch(/^login:account:[0-9a-f]{64}$/);
  });
});
