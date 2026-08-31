import { createHash } from 'node:crypto';

import type { AuthConfig } from '../config.js';
import type { RateLimitStore } from './store.js';

/**
 * Login abuse protection (docs/SECURITY.md §2, §8).
 *
 * Two independent budgets, because the two attacks are different:
 *
 *   * **per source address** — one origin trying many accounts (credential stuffing);
 *   * **per account** — many origins trying one account (targeted brute force).
 *
 * Both are consumed on *failed* attempts only, and a failed attempt against an
 * address that does not exist consumes exactly as much as one against an address that
 * does. The throttled response is therefore identical either way and reveals nothing
 * about whether an account exists.
 *
 * The account key is the SHA-256 of the normalized address, so the store — which may
 * become a shared Redis instance — never holds a user's email in the clear.
 */

export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** Seconds a throttled caller should wait. Zero when allowed. */
  readonly retryAfterSeconds: number;
  /** Which budget was exhausted. For logs and metrics only — never sent to a client. */
  readonly scope?: 'ip' | 'account';
}

const ALLOWED: RateLimitVerdict = { allowed: false, retryAfterSeconds: 0 };

export interface LoginRateLimiter {
  /** Checked before any credential work is done. */
  check(sourceKey: string, email: string): Promise<RateLimitVerdict>;
  /** Consumes budget from both buckets after a failed attempt. */
  recordFailure(sourceKey: string, email: string): Promise<void>;
  /** Clears the account bucket after a successful authentication. */
  recordSuccess(email: string): Promise<void>;
  readonly distributed: boolean;
}

export function accountRateLimitKey(email: string): string {
  return `login:account:${createHash('sha256').update(email, 'utf8').digest('hex')}`;
}

export function sourceRateLimitKey(sourceKey: string): string {
  return `login:ip:${sourceKey}`;
}

export interface LoginRateLimiterOptions {
  readonly store: RateLimitStore;
  readonly config: AuthConfig;
  readonly now?: () => number;
}

export function createLoginRateLimiter(options: LoginRateLimiterOptions): LoginRateLimiter {
  const { store, config } = options;
  const now = options.now ?? ((): number => Date.now());
  const { ipMax, accountMax, windowMs } = config.loginRateLimit;

  function retryAfter(resetAt: number, at: number): number {
    return Math.max(1, Math.ceil((resetAt - at) / 1_000));
  }

  return {
    distributed: store.distributed,

    async check(sourceKey, email): Promise<RateLimitVerdict> {
      const at = now();

      const source = await store.peek(sourceRateLimitKey(sourceKey), at);
      if (source !== null && source.count >= ipMax) {
        return { allowed: false, retryAfterSeconds: retryAfter(source.resetAt, at), scope: 'ip' };
      }

      const account = await store.peek(accountRateLimitKey(email), at);
      if (account !== null && account.count >= accountMax) {
        return {
          allowed: false,
          retryAfterSeconds: retryAfter(account.resetAt, at),
          scope: 'account',
        };
      }

      return { ...ALLOWED, allowed: true };
    },

    async recordFailure(sourceKey, email): Promise<void> {
      const at = now();
      await store.hit(sourceRateLimitKey(sourceKey), windowMs, at);
      await store.hit(accountRateLimitKey(email), windowMs, at);
    },

    async recordSuccess(email): Promise<void> {
      // Only the account budget is cleared. The source budget keeps counting, so one
      // valid credential does not buy an attacker an unlimited spraying run.
      await store.reset(accountRateLimitKey(email));
    },
  };
}
