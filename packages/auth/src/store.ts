/**
 * Persistence port for authentication.
 *
 * This package defines the interface; `@organic-os/database` implements it against
 * PostgreSQL (ADR-0011). Authentication therefore holds no SQL and no knowledge of
 * the schema, and the database package holds no security policy.
 *
 * Every method here is deliberately narrow. In particular there is no "find users
 * matching …": the only user lookups are by exact email and by id, which is what
 * makes the database-side policy backing them (migration 0003) able to forbid
 * enumeration outright.
 */

/** Identity fields authentication needs. Never carries organization membership. */
export interface AuthUserRecord {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly locale: string;
  /** Argon2id encoded hash, or null for a user who has never set a password. */
  readonly passwordHash: string | null;
  /**
   * Platform-operations flag. Loaded as identity data because the schema carries it;
   * it grants nothing in this phase and no code path here can set it
   * (docs/SECURITY.md §3).
   */
  readonly isPlatformAdmin: boolean;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastUsedAt: Date;
  readonly revokedAt: Date | null;
}

export interface CreateSessionInput {
  readonly userId: string;
  readonly tokenHash: Buffer;
  readonly expiresAt: Date;
  readonly now: Date;
  /** Source address, when known and trusted. Stored for incident review. */
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface ResolvedSession {
  readonly session: SessionRecord;
  readonly user: AuthUserRecord;
}

export interface AuthStore {
  /** Exact-match lookup on the normalized address. Returns null when absent. */
  findUserByEmail(email: string): Promise<AuthUserRecord | null>;
  findUserById(userId: string): Promise<AuthUserRecord | null>;

  /**
   * Records a successful authentication on the user row.
   *
   * The runtime role holds a column-scoped UPDATE grant covering `last_login_at`
   * only, so this call cannot touch `password_hash` or `is_platform_admin` even if it
   * tried (migration 0003).
   */
  recordLogin(userId: string, at: Date): Promise<void>;

  createSession(input: CreateSessionInput): Promise<SessionRecord>;

  /**
   * Resolves a session by token hash, together with its user.
   *
   * Implementations must exclude revoked and absolutely-expired sessions in the
   * query itself; the idle window is applied by `SessionService` on top, so the
   * lifetime policy stays in one place.
   */
  findSessionByTokenHash(tokenHash: Buffer, now: Date): Promise<ResolvedSession | null>;

  /** Updates `last_used_at`. Throttled by the service, not by the store. */
  touchSession(sessionId: string, at: Date): Promise<void>;

  /** @returns true when a live session was revoked by this call. */
  revokeSession(sessionId: string, at: Date): Promise<boolean>;

  /** @returns the number of live sessions revoked. */
  revokeAllSessionsForUser(userId: string, at: Date): Promise<number>;

  /**
   * Deletes finished sessions (expired or revoked) that ended before `before`.
   *
   * @returns the number of rows removed.
   */
  deleteFinishedSessions(before: Date): Promise<number>;
}
