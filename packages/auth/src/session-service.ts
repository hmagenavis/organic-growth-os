import type { AuthConfig } from './config.js';
import type { AuthFailureReason } from './errors.js';
import type { AuthStore, AuthUserRecord, SessionRecord } from './store.js';
import { generateSessionToken, hashSessionToken, isWellFormedSessionToken } from './tokens.js';

/**
 * Server-side session lifecycle (ADR-0013).
 *
 * The service owns *policy* — lifetimes, rotation, revocation, what counts as a live
 * session — and delegates every row to the `AuthStore` port. Nothing here knows about
 * HTTP, cookies or Fastify.
 *
 * Two properties hold by construction:
 *
 *   * the raw token exists only in this process and in the browser cookie; the store
 *     is only ever handed `hashSessionToken(raw)`;
 *   * a session is live only while it is unrevoked, inside its absolute lifetime and
 *     inside its idle window — checked on every resolution, not only at creation.
 */

/** Identity established by a valid session. Carries no organization authorization. */
export interface AuthenticatedIdentity {
  readonly user: AuthUserRecord;
  readonly session: SessionRecord;
}

export interface IssuedSession {
  /** Handed to the browser once, in the session cookie. Never persisted, never logged. */
  readonly token: string;
  readonly session: SessionRecord;
}

export interface SessionMetadata {
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export type SessionResolution =
  | { readonly ok: true; readonly identity: AuthenticatedIdentity }
  | { readonly ok: false; readonly reason: AuthFailureReason };

export interface SessionServiceOptions {
  readonly store: AuthStore;
  readonly config: AuthConfig;
  /** Injectable clock. Tests advance it; production leaves it at `Date.now`. */
  readonly now?: () => Date;
}

export interface SessionService {
  createSession(userId: string, metadata?: SessionMetadata): Promise<IssuedSession>;
  /** Resolves a raw cookie token to an identity, or explains why it did not. */
  resolveSession(rawToken: string | undefined): Promise<SessionResolution>;
  /**
   * Replaces a live session with a new one for the same user.
   *
   * Used after any security-sensitive event — authentication over an existing
   * session, a password change, or a membership/privilege change (which Phase 0.4
   * will call into). The old session is revoked before the new one is issued, so the
   * old token can never be valid alongside the new one.
   */
  rotateSession(rawToken: string, metadata?: SessionMetadata): Promise<IssuedSession | null>;
  /** Revokes the session a raw token refers to. Safe to call with a stale token. */
  revokeByToken(rawToken: string | undefined): Promise<boolean>;
  revokeById(sessionId: string): Promise<boolean>;
  revokeAllForUser(userId: string): Promise<number>;
  /** Deletes finished sessions past the configured grace window. */
  cleanupFinishedSessions(): Promise<number>;
}

export function createSessionService(options: SessionServiceOptions): SessionService {
  const { store, config } = options;
  const now = options.now ?? ((): Date => new Date());

  async function issue(userId: string, metadata: SessionMetadata): Promise<IssuedSession> {
    const at = now();
    const token = generateSessionToken();

    const session = await store.createSession({
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(at.getTime() + config.absoluteLifetimeMs),
      now: at,
      ip: metadata.ip,
      userAgent: metadata.userAgent,
    });

    return { token, session };
  }

  return {
    async createSession(userId, metadata = {}): Promise<IssuedSession> {
      return issue(userId, metadata);
    },

    async resolveSession(rawToken): Promise<SessionResolution> {
      if (rawToken === undefined || rawToken === '') {
        return { ok: false, reason: 'no_session_cookie' };
      }

      // A value that cannot have been produced by our generator is rejected before it
      // ever becomes a query parameter.
      if (!isWellFormedSessionToken(rawToken)) {
        return { ok: false, reason: 'session_not_found' };
      }

      const at = now();
      const resolved = await store.findSessionByTokenHash(hashSessionToken(rawToken), at);

      if (resolved === null) {
        // The store excludes revoked and expired rows, so the three cases are
        // indistinguishable from here. Callers get the same generic outcome anyway.
        return { ok: false, reason: 'session_not_found' };
      }

      const { session, user } = resolved;

      if (session.revokedAt !== null) {
        return { ok: false, reason: 'session_revoked' };
      }

      if (session.expiresAt.getTime() <= at.getTime()) {
        return { ok: false, reason: 'session_expired' };
      }

      if (at.getTime() - session.lastUsedAt.getTime() > config.idleTimeoutMs) {
        // Idle-expired sessions are revoked eagerly so the row cannot be revived by a
        // later request and so cleanup can collect it.
        await store.revokeSession(session.id, at);
        return { ok: false, reason: 'session_idle_expired' };
      }

      if (at.getTime() - session.lastUsedAt.getTime() >= config.touchIntervalMs) {
        await store.touchSession(session.id, at);
        return {
          ok: true,
          identity: { user, session: { ...session, lastUsedAt: at } },
        };
      }

      return { ok: true, identity: { user, session } };
    },

    async rotateSession(rawToken, metadata = {}): Promise<IssuedSession | null> {
      const resolution = await this.resolveSession(rawToken);

      if (!resolution.ok) {
        return null;
      }

      const { session, user } = resolution.identity;
      await store.revokeSession(session.id, now());
      return issue(user.id, metadata);
    },

    async revokeByToken(rawToken): Promise<boolean> {
      if (rawToken === undefined || rawToken === '' || !isWellFormedSessionToken(rawToken)) {
        return false;
      }

      const at = now();
      const resolved = await store.findSessionByTokenHash(hashSessionToken(rawToken), at);

      if (resolved === null) {
        return false;
      }

      return store.revokeSession(resolved.session.id, at);
    },

    async revokeById(sessionId): Promise<boolean> {
      return store.revokeSession(sessionId, now());
    },

    async revokeAllForUser(userId): Promise<number> {
      return store.revokeAllSessionsForUser(userId, now());
    },

    async cleanupFinishedSessions(): Promise<number> {
      return store.deleteFinishedSessions(new Date(now().getTime() - config.cleanupGraceMs));
    },
  };
}
