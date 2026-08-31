import type {
  AuthStore,
  AuthUserRecord,
  CreateSessionInput,
  ResolvedSession,
  SessionRecord,
} from '@organic-os/auth';
import { and, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../client.js';
import { newId } from '../ids.js';
import { requireRow } from '../repositories/util.js';
import { sessions, users } from '../schema/index.js';

/**
 * PostgreSQL implementation of the authentication persistence port (ADR-0011).
 *
 * Two invariants this module upholds, both enforced by the database rather than by
 * convention (migration 0003):
 *
 *   * **Identity lookups are point lookups.** `users` is under FORCE RLS with no
 *     unconditional read policy for the runtime role. A read succeeds only for the
 *     one row whose email or id was established transaction-locally by
 *     `withAuthContext`. Forgetting to establish it returns zero rows rather than
 *     everything — the same fail-closed shape as tenant context.
 *
 *   * **Authentication is not tenancy.** Nothing here sets `app.current_org_id`, and
 *     the settings it does use are separate ones. A valid session therefore grants no
 *     access to any organization-scoped table; establishing tenant authorization is
 *     sub-phase 0.4's job (docs/SECURITY.md §4).
 *
 * `sessions` is intentionally outside RLS (0002): a session is resolved from a token
 * hash before any organization is known. Access is constrained by the 256-bit token
 * itself, and the table holds no tenant data — only a user id, a hash and lifecycle
 * timestamps.
 */

/** Transaction-local settings that unlock the point lookup. Never session-level. */
interface AuthLookupContext {
  readonly email?: string;
  readonly userId?: string;
}

/**
 * Establishes the authentication lookup context.
 *
 * `set_config(..., true)` is transaction-local: discarded at COMMIT *and* at ROLLBACK,
 * so it can never survive a connection returning to the pool. Session-level `SET`
 * appears nowhere in this package (docs/SECURITY.md §4).
 */
async function applyAuthContext(tx: Transaction, context: AuthLookupContext): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.auth_email', ${context.email ?? ''}, true)`);
  await tx.execute(sql`SELECT set_config('app.auth_user_id', ${context.userId ?? ''}, true)`);
}

type UserRow = typeof users.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;

function toUser(row: UserRow): AuthUserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    locale: row.locale,
    passwordHash: row.passwordHash,
    isPlatformAdmin: row.isPlatformAdmin,
  };
}

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

async function selectUserByEmail(tx: Transaction, email: string): Promise<AuthUserRecord | null> {
  const rows = await tx.select().from(users).where(eq(users.email, email)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toUser(row);
}

async function selectUserById(tx: Transaction, userId: string): Promise<AuthUserRecord | null> {
  const rows = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toUser(row);
}

/**
 * Builds the store over a runtime (RLS-constrained) database handle.
 *
 * The provisioning role is never used here: authentication reads and writes only what
 * the runtime role is granted, so no application request can reach privileged
 * credentials (docs/SECURITY.md §5).
 */
export function createAuthStore(db: Database): AuthStore {
  return {
    async findUserByEmail(email: string): Promise<AuthUserRecord | null> {
      return db.transaction(async (tx) => {
        await applyAuthContext(tx, { email });
        return selectUserByEmail(tx, email);
      });
    },

    async findUserById(userId: string): Promise<AuthUserRecord | null> {
      return db.transaction(async (tx) => {
        await applyAuthContext(tx, { userId });
        return selectUserById(tx, userId);
      });
    },

    async recordLogin(userId: string, at: Date): Promise<void> {
      await db.transaction(async (tx) => {
        await applyAuthContext(tx, { userId });
        // Only last_login_at is in the target list, and the runtime role holds no
        // other UPDATE privilege on this table — password_hash, email and
        // is_platform_admin are unreachable from here no matter what SQL is issued.
        await tx.update(users).set({ lastLoginAt: at }).where(eq(users.id, userId));
      });
    },

    async createSession(input: CreateSessionInput): Promise<SessionRecord> {
      const rows = await db
        .insert(sessions)
        .values({
          id: newId(),
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          lastUsedAt: input.now,
          createdAt: input.now,
          ...(input.ip === undefined ? {} : { ip: input.ip }),
          ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
        })
        .returning();

      return toSession(requireRow(rows, 'createSession'));
    },

    async findSessionByTokenHash(tokenHash: Buffer, now: Date): Promise<ResolvedSession | null> {
      // One transaction: the session row identifies the user, and the authentication
      // context for that user is established before the identity row is read.
      return db.transaction(async (tx) => {
        const sessionRows = await tx
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.tokenHash, tokenHash),
              isNull(sessions.revokedAt),
              gt(sessions.expiresAt, now),
            ),
          )
          .limit(1);

        const sessionRow = sessionRows[0];

        if (sessionRow === undefined) {
          return null;
        }

        await applyAuthContext(tx, { userId: sessionRow.userId });
        const user = await selectUserById(tx, sessionRow.userId);

        // A session whose user no longer exists resolves to nothing rather than to a
        // partial identity.
        return user === null ? null : { session: toSession(sessionRow), user };
      });
    },

    async touchSession(sessionId: string, at: Date): Promise<void> {
      await db.update(sessions).set({ lastUsedAt: at }).where(eq(sessions.id, sessionId));
    },

    async revokeSession(sessionId: string, at: Date): Promise<boolean> {
      const rows = await db
        .update(sessions)
        .set({ revokedAt: at })
        .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });

      return rows.length > 0;
    },

    async revokeAllSessionsForUser(userId: string, at: Date): Promise<number> {
      const rows = await db
        .update(sessions)
        .set({ revokedAt: at })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });

      return rows.length;
    },

    async deleteFinishedSessions(before: Date): Promise<number> {
      // A session is finished once it is revoked or past its absolute expiry, and
      // collectable once that moment is older than the grace window.
      const rows = await db
        .delete(sessions)
        .where(
          or(
            and(isNotNull(sessions.revokedAt), lt(sessions.revokedAt, before)),
            lt(sessions.expiresAt, before),
          ),
        )
        .returning({ id: sessions.id });

      return rows.length;
    },
  };
}
