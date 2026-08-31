import type { RateLimitHit, RateLimitStore } from './store.js';

/**
 * Single-process fixed-window rate-limit store.
 *
 * **Limitation, stated plainly:** counters live in one Node.js process's heap. With
 * more than one API instance behind a load balancer, an attacker gets the configured
 * budget *per instance*, and a restart clears every counter. This is real protection
 * against a single-source credential-stuffing run against a single-instance
 * deployment, and nothing more.
 *
 * It is not a placeholder or a mock — it enforces exactly what it claims — but a
 * multi-instance production deployment must not claim distributed brute-force
 * protection until sub-phase 0.5 introduces Redis and a `RedisRateLimitStore` takes
 * its place behind the same interface. `distributed` is `false` so a deployment check
 * can assert this rather than assume it.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  readonly distributed = false;

  readonly #windows = new Map<string, { count: number; resetAt: number }>();

  /** Bound on retained keys, so an attacker cannot grow the map without limit. */
  readonly #maxKeys: number;

  constructor(maxKeys = 100_000) {
    this.#maxKeys = maxKeys;
  }

  // The port is asynchronous because its real implementation talks to Redis. These
  // methods are genuinely synchronous, so they resolve rather than pretending to await.
  hit(key: string, windowMs: number, now: number): Promise<RateLimitHit> {
    this.#pruneExpired(now);

    const existing = this.#windows.get(key);

    if (existing === undefined || existing.resetAt <= now) {
      if (this.#windows.size >= this.#maxKeys) {
        this.#evictOldest();
      }

      const created = { count: 1, resetAt: now + windowMs };
      this.#windows.set(key, created);
      return Promise.resolve({ ...created });
    }

    existing.count += 1;
    return Promise.resolve({ ...existing });
  }

  peek(key: string, now: number): Promise<RateLimitHit | null> {
    const existing = this.#windows.get(key);

    if (existing === undefined || existing.resetAt <= now) {
      return Promise.resolve(null);
    }

    return Promise.resolve({ ...existing });
  }

  reset(key: string): Promise<void> {
    this.#windows.delete(key);
    return Promise.resolve();
  }

  #pruneExpired(now: number): void {
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= now) {
        this.#windows.delete(key);
      }
    }
  }

  #evictOldest(): void {
    // Map preserves insertion order, so the first key is the least recently created.
    const oldest = this.#windows.keys().next();

    if (oldest.done !== true) {
      this.#windows.delete(oldest.value);
    }
  }
}
