import { randomUUID } from 'node:crypto';

import type {
  AuthStore,
  AuthUserRecord,
  CreateSessionInput,
  ResolvedSession,
  SessionRecord,
} from '../store.js';

/**
 * TEST-ONLY implementation of the authentication persistence port.
 *
 * This exists so the HTTP layer and the session policy can be tested without a
 * database. It is **not** a session backend: it is reachable only through the
 * `@organic-os/auth/testing` subpath, and its constructor refuses to run under
 * `NODE_ENV=production`, so it cannot become one by accident.
 *
 * The behaviour it implements matches the port's contract exactly — including
 * excluding revoked and expired rows from `findSessionByTokenHash` — so a test that
 * passes here is testing the same rules PostgreSQL enforces. The properties it cannot
 * model (Row Level Security, grants, concurrency) are covered by the integration
 * suite against real PostgreSQL, never here.
 */
export class InMemoryAuthStore implements AuthStore {
  readonly #users = new Map<string, AuthUserRecord>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #tokenIndex = new Map<string, string>();
  readonly #logins = new Map<string, Date>();

  constructor() {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error('InMemoryAuthStore must never be used in production');
    }
  }

  /** Seeds an identity. Takes a hash, never a password — the same rule as production. */
  addUser(
    user: Omit<AuthUserRecord, 'id' | 'locale'> & { id?: string; locale?: string },
  ): AuthUserRecord {
    const record: AuthUserRecord = {
      id: user.id ?? randomUUID(),
      email: user.email.toLowerCase(),
      name: user.name,
      locale: user.locale ?? 'en',
      passwordHash: user.passwordHash,
      isPlatformAdmin: user.isPlatformAdmin,
    };

    this.#users.set(record.id, record);
    return record;
  }

  /** Exposed so tests can assert what was persisted, e.g. that no raw token was. */
  allSessions(): SessionRecord[] {
    return [...this.#sessions.values()];
  }

  storedTokenHashes(): string[] {
    return [...this.#tokenIndex.keys()];
  }

  lastLoginAt(userId: string): Date | undefined {
    return this.#logins.get(userId);
  }

  // Every method below is genuinely synchronous, so it resolves rather than being
  // marked `async` with nothing to await.
  findUserByEmail(email: string): Promise<AuthUserRecord | null> {
    const normalized = email.toLowerCase();
    return Promise.resolve(
      [...this.#users.values()].find((user) => user.email === normalized) ?? null,
    );
  }

  findUserById(userId: string): Promise<AuthUserRecord | null> {
    return Promise.resolve(this.#users.get(userId) ?? null);
  }

  recordLogin(userId: string, at: Date): Promise<void> {
    this.#logins.set(userId, at);
    return Promise.resolve();
  }

  createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const session: SessionRecord = {
      id: randomUUID(),
      userId: input.userId,
      createdAt: input.now,
      expiresAt: input.expiresAt,
      lastUsedAt: input.now,
      revokedAt: null,
    };

    this.#sessions.set(session.id, session);
    this.#tokenIndex.set(input.tokenHash.toString('hex'), session.id);
    return Promise.resolve(session);
  }

  findSessionByTokenHash(tokenHash: Buffer, now: Date): Promise<ResolvedSession | null> {
    const sessionId = this.#tokenIndex.get(tokenHash.toString('hex'));
    const session = sessionId === undefined ? undefined : this.#sessions.get(sessionId);

    if (session === undefined || session.revokedAt !== null) {
      return Promise.resolve(null);
    }

    if (session.expiresAt.getTime() <= now.getTime()) {
      return Promise.resolve(null);
    }

    const user = this.#users.get(session.userId);
    return Promise.resolve(user === undefined ? null : { session, user });
  }

  touchSession(sessionId: string, at: Date): Promise<void> {
    const session = this.#sessions.get(sessionId);

    if (session !== undefined) {
      this.#sessions.set(sessionId, { ...session, lastUsedAt: at });
    }

    return Promise.resolve();
  }

  revokeSession(sessionId: string, at: Date): Promise<boolean> {
    const session = this.#sessions.get(sessionId);

    if (session === undefined || session.revokedAt !== null) {
      return Promise.resolve(false);
    }

    this.#sessions.set(sessionId, { ...session, revokedAt: at });
    return Promise.resolve(true);
  }

  revokeAllSessionsForUser(userId: string, at: Date): Promise<number> {
    let revoked = 0;

    for (const session of this.#sessions.values()) {
      if (session.userId === userId && session.revokedAt === null) {
        this.#sessions.set(session.id, { ...session, revokedAt: at });
        revoked += 1;
      }
    }

    return Promise.resolve(revoked);
  }

  deleteFinishedSessions(before: Date): Promise<number> {
    let deleted = 0;

    for (const session of [...this.#sessions.values()]) {
      const finishedBefore =
        (session.revokedAt !== null && session.revokedAt.getTime() < before.getTime()) ||
        session.expiresAt.getTime() < before.getTime();

      if (finishedBefore) {
        this.#sessions.delete(session.id);

        for (const [hash, id] of this.#tokenIndex) {
          if (id === session.id) {
            this.#tokenIndex.delete(hash);
          }
        }

        deleted += 1;
      }
    }

    return Promise.resolve(deleted);
  }
}
