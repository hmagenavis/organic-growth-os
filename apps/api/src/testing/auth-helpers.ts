import {
  createPasswordHasher,
  CSRF_HEADER_NAME,
  parseCookieHeader,
  type AuthConfig,
} from '@organic-os/auth';
import type { LightMyRequestResponse } from 'fastify';

/**
 * Helpers shared by the authentication test suites (unit and integration).
 *
 * They exist so both suites drive the API the way a browser does — carrying cookies
 * forward and echoing the CSRF token — instead of each reimplementing that and
 * accidentally testing something weaker.
 */

/** Cost parameters for tests only. Production values are asserted in `@organic-os/auth`. */
export const TEST_HASH_PARAMETERS = { memoryCost: 8_192, timeCost: 1, parallelism: 1 } as const;

export const TEST_AUTH_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  AUTH_SESSION_SECRET: 'test-only-session-secret-that-is-long-enough',
  AUTH_ARGON2_MEMORY_COST_KIB: String(TEST_HASH_PARAMETERS.memoryCost),
  AUTH_ARGON2_TIME_COST: String(TEST_HASH_PARAMETERS.timeCost),
  AUTH_ARGON2_PARALLELISM: String(TEST_HASH_PARAMETERS.parallelism),
};

export const testPasswordHasher = createPasswordHasher(TEST_HASH_PARAMETERS);

/** A minimal cookie jar: enough to carry state between injected requests. */
export class CookieJar {
  readonly #cookies = new Map<string, string>();

  absorb(response: LightMyRequestResponse): void {
    const header = response.headers['set-cookie'];
    const values = header === undefined ? [] : Array.isArray(header) ? header : [String(header)];

    for (const value of values) {
      const [pair = ''] = value.split(';');
      const parsed = parseCookieHeader(pair);

      for (const [name, cookieValue] of Object.entries(parsed)) {
        if (cookieValue === '') {
          this.#cookies.delete(name);
        } else {
          this.#cookies.set(name, cookieValue);
        }
      }
    }
  }

  get(name: string): string | undefined {
    return this.#cookies.get(name);
  }

  set(name: string, value: string): void {
    this.#cookies.set(name, value);
  }

  clear(): void {
    this.#cookies.clear();
  }

  header(): string {
    return [...this.#cookies]
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join('; ');
  }

  /** Headers a browser holding these cookies would send for a state-changing request. */
  headersFor(config: AuthConfig): Record<string, string> {
    const csrf = this.#cookies.get(config.cookies.csrfCookieName);

    return {
      cookie: this.header(),
      ...(csrf === undefined ? {} : { [CSRF_HEADER_NAME]: csrf }),
    };
  }
}
