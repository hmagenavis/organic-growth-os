/**
 * Rate-limit persistence port.
 *
 * Deliberately tiny, and deliberately expressed as one atomic operation
 * (`hit` = increment-and-read within a fixed window), because that is the shape a
 * Redis implementation can satisfy with `INCR` + `EXPIRE`. Sub-phase 0.5 replaces the
 * in-memory implementation with a Redis-backed one without touching any caller.
 */

export interface RateLimitHit {
  /** Number of hits recorded in the current window, including this one. */
  readonly count: number;
  /** Epoch milliseconds at which the current window ends. */
  readonly resetAt: number;
}

export interface RateLimitStore {
  /** Records one hit against `key` and returns the window state. */
  hit(key: string, windowMs: number, now: number): Promise<RateLimitHit>;
  /** Reads the window state without recording a hit. */
  peek(key: string, now: number): Promise<RateLimitHit | null>;
  /** Clears a key — used after a successful authentication. */
  reset(key: string): Promise<void>;
  /**
   * True when this implementation shares state across every process serving traffic.
   *
   * Exposed so a deployment can assert the property rather than assume it; an
   * in-memory store must never be presented as distributed protection.
   */
  readonly distributed: boolean;
}
