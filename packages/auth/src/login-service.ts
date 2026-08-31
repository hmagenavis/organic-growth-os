import { randomBytes } from 'node:crypto';

import type { AuthFailureReason } from './errors.js';
import type { PasswordHasher } from './password.js';
import type { LoginRateLimiter } from './rate-limit/login-limiter.js';
import type { IssuedSession, SessionMetadata, SessionService } from './session-service.js';
import type { AuthStore, AuthUserRecord } from './store.js';

/**
 * Credential authentication.
 *
 * Three properties this module exists to guarantee:
 *
 *   1. **One external outcome for every failure.** Unknown address, no credential set,
 *      and wrong password all produce `{ ok: false, reason }` where `reason` is a
 *      coarse category for the server log only. The API maps every one of them to the
 *      same problem+json response.
 *   2. **No usable timing signal.** When there is no stored hash to verify against,
 *      the provided password is still verified — against a throwaway hash generated
 *      at construction with the same cost parameters — so an unknown address costs
 *      the same wall-clock time as a wrong password.
 *   3. **Rotation on authentication.** If the caller already held a session, it is
 *      revoked and replaced rather than reused, so a fixated session cannot survive a
 *      login (docs/SECURITY.md §2).
 */

export interface LoginRequest {
  readonly email: string;
  readonly password: string;
  /** Stable key identifying the request source for rate limiting. */
  readonly sourceKey: string;
  /** Raw session token the caller already presented, if any. */
  readonly existingSessionToken?: string | undefined;
  readonly metadata?: SessionMetadata;
}

export type LoginResult =
  | {
      readonly ok: true;
      readonly user: AuthUserRecord;
      readonly session: IssuedSession;
    }
  | {
      readonly ok: false;
      readonly reason: AuthFailureReason;
      /** Present only when `reason` is `rate_limited`. */
      readonly retryAfterSeconds?: number;
    };

export interface LoginService {
  login(request: LoginRequest): Promise<LoginResult>;
}

/**
 * Normalizes an address for lookup and for rate-limit keying.
 *
 * `users.email` is `citext`, so the database already matches case-insensitively; this
 * makes the *application's* view consistent too, so `A@x.test` and `a@x.test` cannot
 * be given separate rate-limit budgets. Nothing beyond trimming and lower-casing is
 * done: stripping dots or `+tags` would silently merge addresses that are distinct
 * mailboxes at most providers.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface LoginServiceOptions {
  readonly store: AuthStore;
  readonly sessions: SessionService;
  readonly passwords: PasswordHasher;
  readonly rateLimiter: LoginRateLimiter;
  readonly now?: () => Date;
}

export function createLoginService(options: LoginServiceOptions): LoginService {
  const { store, sessions, passwords, rateLimiter } = options;
  const now = options.now ?? ((): Date => new Date());

  /**
   * A hash used only to burn the same CPU time as a real verification when there is
   * no credential to check. Its plaintext is random and immediately discarded, so it
   * can never match anything. Computed once, on first need, and memoised — building
   * it eagerly would make every consumer's construction asynchronous.
   */
  let timingEqualizerHash: Promise<string> | undefined;

  function equalizerHash(): Promise<string> {
    timingEqualizerHash ??= passwords.hash(randomBytes(32).toString('base64url'));
    return timingEqualizerHash;
  }

  return {
    async login(request: LoginRequest): Promise<LoginResult> {
      const email = normalizeEmail(request.email);

      const verdict = await rateLimiter.check(request.sourceKey, email);
      if (!verdict.allowed) {
        return {
          ok: false,
          reason: 'rate_limited',
          retryAfterSeconds: verdict.retryAfterSeconds,
        };
      }

      const user = await store.findUserByEmail(email);

      if (user === null || user.passwordHash === null) {
        // Same work, same duration, same outcome as a wrong password.
        await passwords.verify(await equalizerHash(), request.password);
        await rateLimiter.recordFailure(request.sourceKey, email);
        return { ok: false, reason: user === null ? 'unknown_user' : 'no_credential' };
      }

      const matches = await passwords.verify(user.passwordHash, request.password);

      if (!matches) {
        await rateLimiter.recordFailure(request.sourceKey, email);
        return { ok: false, reason: 'bad_password' };
      }

      // Rotation on authentication: an already-held session never survives a login.
      if (request.existingSessionToken !== undefined && request.existingSessionToken !== '') {
        await sessions.revokeByToken(request.existingSessionToken);
      }

      const session = await sessions.createSession(user.id, request.metadata ?? {});
      await store.recordLogin(user.id, now());
      await rateLimiter.recordSuccess(email);

      return { ok: true, user, session };
    },
  };
}
