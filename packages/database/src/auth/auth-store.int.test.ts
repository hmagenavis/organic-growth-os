import { createAuthConfig, createSessionService, hashSessionToken } from '@organic-os/auth';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { provisionUser } from '../provisioning.js';
import { readCurrentOrganizationId } from '../tenant/transaction.js';
import { withTenantTransaction } from '../tenant/with-tenant-transaction.js';
import { createTestDatabase, type TestDatabase } from '../testing/database.js';
import { seedTwoTenants, type SeededTenants } from '../testing/seed.js';
import { createAuthStore } from './store.js';

/**
 * Authentication persistence against real PostgreSQL.
 *
 * The subject is not "does the store return rows" — it is the database-enforced part:
 * that the identity lookup is a point lookup and not an exemption, that the runtime
 * role cannot write a credential or a privilege flag, and that establishing an
 * authentication context establishes no tenant authority.
 */

const PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$ZGlnZXN0dmFsdWVoZXJl';

const config = createAuthConfig({
  AUTH_SESSION_SECRET: 'test-only-session-secret-that-is-long-enough',
  AUTH_SESSION_ABSOLUTE_LIFETIME_MS: String(60 * 60 * 1_000),
  AUTH_SESSION_IDLE_TIMEOUT_MS: String(30 * 60 * 1_000),
  AUTH_SESSION_TOUCH_INTERVAL_MS: '0',
  AUTH_SESSION_CLEANUP_GRACE_MS: String(60 * 60 * 1_000),
});

let database: TestDatabase;
let tenants: SeededTenants;
let store: ReturnType<typeof createAuthStore>;
let userId: string;
let userEmail: string;

beforeAll(async () => {
  database = await createTestDatabase(inject('postgresAdminUri'), 'organic_os_auth_test');
  tenants = await seedTwoTenants(database.runtime, database.provisioner);
  store = createAuthStore(database.runtime.db);

  // Credentials are written through the privileged provisioning path, which is the
  // only path that can write `password_hash` at all.
  const user = await provisionUser(database.provisioner.db, {
    email: 'Credentialed@Example.Test',
    name: 'Credentialed User',
    passwordHash: PASSWORD_HASH,
  });

  userId = user.id;
  userEmail = user.email;
}, 240_000);

afterAll(async () => {
  await database?.close();
});

/** Raw SQL as the runtime role, with no context of any kind established. */
async function asRuntime<T = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<{ rows: T[]; rowCount: number | null }> {
  const result = await database.runtime.pool.query(text, values);
  return { rows: result.rows as T[], rowCount: result.rowCount };
}

describe('identity lookup', () => {
  it('finds a user by exact address', async () => {
    const user = await store.findUserByEmail('credentialed@example.test');

    expect(user?.id).toBe(userId);
    expect(user?.passwordHash).toBe(PASSWORD_HASH);
    expect(user?.isPlatformAdmin).toBe(false);
  });

  it('matches the address case-insensitively, as citext specifies', async () => {
    expect((await store.findUserByEmail('CREDENTIALED@EXAMPLE.TEST'))?.id).toBe(userId);
  });

  it('finds a user by id', async () => {
    expect((await store.findUserById(userId))?.email).toBe(userEmail);
  });

  it('returns null for an unknown address or id', async () => {
    expect(await store.findUserByEmail('nobody@example.test')).toBeNull();
    expect(await store.findUserById('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('fails closed: with no authentication context the runtime role sees no users', async () => {
    // This is the property migration 0003 exists to preserve. Without the
    // transaction-local setting, the policy predicate is NULL and matches nothing.
    const all = await asRuntime('SELECT id FROM users');
    expect(all.rows).toHaveLength(0);

    const byEmail = await asRuntime('SELECT id FROM users WHERE email = $1', [userEmail]);
    expect(byEmail.rows).toHaveLength(0);
  });

  it('cannot be turned into an enumeration', async () => {
    // Even with a context established, the policy admits only the matching row —
    // a wildcard query returns one user, not the directory.
    const client = await database.runtime.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.auth_email', userEmail]);

      const everyone = await client.query<{ id: string }>('SELECT id, email FROM users');

      expect(everyone.rows).toHaveLength(1);
      expect(everyone.rows[0]?.id).toBe(userId);

      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('discards the authentication context when the transaction ends', async () => {
    await store.findUserByEmail(userEmail);

    // Same pooled connection, next statement: the setting is gone, so a subsequent
    // caller inherits nothing.
    const leaked = await asRuntime('SELECT app.auth_email() AS email, app.auth_user_id() AS id');

    expect(leaked.rows[0]?.['email']).toBeNull();
    expect(leaked.rows[0]?.['id']).toBeNull();
  });
});

describe('credential and privilege writes are impossible from the runtime role', () => {
  it('records a login without being able to touch anything else', async () => {
    const at = new Date('2026-08-31T10:00:00.000Z');
    await store.recordLogin(userId, at);

    const row = await asRuntime<{ last_login_at: Date }>(
      'SELECT last_login_at FROM users WHERE id = $1',
      [userId],
    );

    // Read back through the provisioning role, which can see the row unconditionally.
    const provisioned = await database.provisioner.pool.query<{ last_login_at: Date }>(
      'SELECT last_login_at FROM users WHERE id = $1',
      [userId],
    );

    expect(row.rows).toHaveLength(0);
    expect(provisioned.rows[0]?.last_login_at).toEqual(at);
  });

  it('cannot write a password hash', async () => {
    const client = await database.runtime.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.auth_user_id', userId]);

      await expect(
        client.query('UPDATE users SET password_hash = $1 WHERE id = $2', ['attacker', userId]),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('cannot grant itself platform administration', async () => {
    const client = await database.runtime.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.auth_user_id', userId]);

      await expect(
        client.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [userId]),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('cannot create a user', async () => {
    await expect(
      asRuntime('INSERT INTO users (id, email, name) VALUES (gen_random_uuid(), $1, $2)', [
        'intruder@example.test',
        'Intruder',
      ]),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot change another user’s last_login_at', async () => {
    const client = await database.runtime.pool.connect();

    try {
      await client.query('BEGIN');
      // Context established for one user, write attempted against another.
      await client.query('SELECT set_config($1, $2, true)', ['app.auth_user_id', userId]);

      const result = await client.query('UPDATE users SET last_login_at = now() WHERE id = $1', [
        tenants.a.userId,
      ]);

      expect(result.rowCount).toBe(0);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });
});

describe('session persistence', () => {
  const sessions = (): ReturnType<typeof createSessionService> =>
    createSessionService({ store, config });

  it('stores a hash, never the token', async () => {
    const { token, session } = await sessions().createSession(userId);

    const row = await asRuntime<{ token_hash: Buffer }>(
      'SELECT token_hash FROM sessions WHERE id = $1',
      [session.id],
    );

    expect(row.rows[0]?.token_hash).toEqual(hashSessionToken(token));
    expect(row.rows[0]?.token_hash.toString('utf8')).not.toContain(token);

    // Nothing anywhere in the row resembles the raw token.
    const whole = await asRuntime('SELECT * FROM sessions WHERE id = $1', [session.id]);
    expect(JSON.stringify(whole.rows[0])).not.toContain(token);
  });

  it('resolves a live session to its user', async () => {
    const { token } = await sessions().createSession(userId);
    const resolution = await sessions().resolveSession(token);

    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.identity.user.id).toBe(userId);
    }
  });

  it('rejects an expired session at the SQL level, not only in policy code', async () => {
    const { token, session } = await sessions().createSession(userId);

    await asRuntime("UPDATE sessions SET expires_at = now() - interval '1 hour' WHERE id = $1", [
      session.id,
    ]);

    expect(await store.findSessionByTokenHash(hashSessionToken(token), new Date())).toBeNull();
    expect((await sessions().resolveSession(token)).ok).toBe(false);
  });

  it('rejects a revoked session', async () => {
    const { token } = await sessions().createSession(userId);

    expect(await sessions().revokeByToken(token)).toBe(true);
    expect(await store.findSessionByTokenHash(hashSessionToken(token), new Date())).toBeNull();
  });

  it('revokes every session of one user and no one else’s', async () => {
    const mine = await Promise.all([
      sessions().createSession(userId),
      sessions().createSession(userId),
    ]);
    const theirs = await sessions().createSession(tenants.a.userId);

    expect(await sessions().revokeAllForUser(userId)).toBeGreaterThanOrEqual(2);

    for (const issued of mine) {
      expect((await sessions().resolveSession(issued.token)).ok).toBe(false);
    }

    expect((await sessions().resolveSession(theirs.token)).ok).toBe(true);
  });

  it('deletes finished sessions and keeps live ones', async () => {
    await sessions().revokeAllForUser(userId);
    await sessions().revokeAllForUser(tenants.a.userId);

    // Push every revocation past the grace window.
    await asRuntime(
      "UPDATE sessions SET revoked_at = now() - interval '2 hours' WHERE revoked_at IS NOT NULL",
    );

    const live = await sessions().createSession(userId);
    const deleted = await sessions().cleanupFinishedSessions();

    expect(deleted).toBeGreaterThan(0);

    const remaining = await asRuntime<{ id: string }>('SELECT id FROM sessions');
    expect(remaining.rows.map((row) => row.id)).toEqual([live.session.id]);

    await sessions().revokeByToken(live.token);
  });
});

describe('authentication is not tenant authorization', () => {
  it('establishes no organization context while resolving an identity', async () => {
    // Every lookup runs on the pool; afterwards the pooled connection must carry no
    // tenant identity at all.
    await store.findUserByEmail(userEmail);
    await store.findUserById(userId);

    expect(await readCurrentOrganizationId(database.runtime.db)).toBeNull();
  });

  it('a valid session for a user grants that user no organization rows', async () => {
    const { token } = await createSessionService({ store, config }).createSession(tenants.a.userId);

    const resolution = await createSessionService({ store, config }).resolveSession(token);
    expect(resolution.ok).toBe(true);

    // The user is a real agency_admin of organization A. Authentication alone still
    // reaches nothing: without the Phase 0.4 authorization step establishing
    // app.current_org_id, every tenant table is empty and every write is refused.
    expect(await readCurrentOrganizationId(database.runtime.db)).toBeNull();
    expect((await asRuntime('SELECT id FROM organizations')).rows).toHaveLength(0);
    expect((await asRuntime('SELECT id FROM clients')).rows).toHaveLength(0);
    expect((await asRuntime('SELECT id FROM sites')).rows).toHaveLength(0);
    expect((await asRuntime('SELECT id FROM memberships')).rows).toHaveLength(0);
    expect((await asRuntime('SELECT id FROM audit_logs')).rows).toHaveLength(0);

    const write = await asRuntime(
      "INSERT INTO clients (id, organization_id, name) VALUES (gen_random_uuid(), $1, 'forged') RETURNING id",
      [tenants.a.organization.id],
    ).catch((error: unknown) => error);

    expect(write).toBeInstanceOf(Error);
  });

  it('the authentication context cannot be used as a tenant context', async () => {
    const client = await database.runtime.pool.connect();

    try {
      await client.query('BEGIN');
      // Set every authentication setting there is; none of them is app.current_org_id.
      await client.query('SELECT set_config($1, $2, true)', ['app.auth_user_id', tenants.a.userId]);
      await client.query('SELECT set_config($1, $2, true)', ['app.auth_email', userEmail]);

      const orgId = await client.query<{ id: string | null }>('SELECT app.current_org_id() AS id');
      const clients = await client.query('SELECT id FROM clients');

      expect(orgId.rows[0]?.id).toBeNull();
      expect(clients.rows).toHaveLength(0);

      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('a tenant context still works exactly as before, unaffected by the auth path', async () => {
    await store.findUserByEmail(userEmail);

    const clients = await withTenantTransaction(database.runtime.db, tenants.a.tenant, (repos) =>
      repos.clients.list(),
    );

    expect(clients).toHaveLength(1);
    expect(clients[0]?.id).toBe(tenants.a.clientId);
  });
});

describe('provisioning credentials are unreachable from the runtime role', () => {
  it('the runtime role holds no privilege that could elevate it', async () => {
    const attributes = await asRuntime<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
    }>(
      'SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user',
    );

    expect(attributes.rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });
  });

  it('the runtime role is not a member of the provisioning or migration role', async () => {
    const memberships = await asRuntime<{ rolname: string }>(
      `SELECT r.rolname
         FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.roleid
        WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)`,
    );

    expect(memberships.rows.map((row) => row.rolname)).not.toContain('organic_os_provisioner');
    expect(memberships.rows.map((row) => row.rolname)).not.toContain('organic_os_migrator');
  });

  it('the runtime role cannot create an organization', async () => {
    await expect(
      asRuntime(
        "INSERT INTO organizations (id, name, slug) VALUES (gen_random_uuid(), 'Forged', 'forged')",
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the sessions table is not a path into tenant data', async () => {
    // sessions is outside RLS by design; it must therefore hold nothing tenant-scoped.
    const columns = await asRuntime<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'sessions'",
    );

    const names = columns.rows.map((row) => row.column_name);

    expect(names).not.toContain('organization_id');
    expect(names).not.toContain('client_id');
    expect(names).not.toContain('site_id');
    expect(names.sort()).toEqual([
      'created_at',
      'expires_at',
      'id',
      'ip',
      'last_used_at',
      'revoked_at',
      'token_hash',
      'user_agent',
      'user_id',
    ]);
  });
});
