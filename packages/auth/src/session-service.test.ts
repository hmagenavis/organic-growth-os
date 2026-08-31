import { beforeEach, describe, expect, it } from 'vitest';

import { createAuthConfig, type AuthConfig } from './config.js';
import { createSessionService, type SessionService } from './session-service.js';
import { InMemoryAuthStore } from './testing/in-memory-store.js';
import { hashSessionToken } from './tokens.js';

const SECRET = 'x'.repeat(64);
const START = new Date('2026-08-31T09:00:00.000Z');

const config: AuthConfig = createAuthConfig({
  AUTH_SESSION_SECRET: SECRET,
  AUTH_SESSION_ABSOLUTE_LIFETIME_MS: String(12 * 60 * 60 * 1_000),
  AUTH_SESSION_IDLE_TIMEOUT_MS: String(2 * 60 * 60 * 1_000),
  AUTH_SESSION_TOUCH_INTERVAL_MS: String(60_000),
  AUTH_SESSION_CLEANUP_GRACE_MS: String(24 * 60 * 60 * 1_000),
});

let store: InMemoryAuthStore;
let sessions: SessionService;
let clock: Date;
let userId: string;

function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

beforeEach(() => {
  clock = START;
  store = new InMemoryAuthStore();
  sessions = createSessionService({ store, config, now: () => clock });
  userId = store.addUser({
    email: 'owner@example.test',
    name: 'Owner',
    passwordHash: '$argon2id$stub',
    isPlatformAdmin: false,
  }).id;
});

describe('session creation', () => {
  it('returns a raw token and stores only its hash', async () => {
    const { token, session } = await sessions.createSession(userId);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.storedTokenHashes()).toEqual([hashSessionToken(token).toString('hex')]);
    // Nothing persisted anywhere resembles the token the browser holds.
    expect(JSON.stringify(store.allSessions())).not.toContain(token);
    expect(session.userId).toBe(userId);
  });

  it('sets the absolute expiry from configuration', async () => {
    const { session } = await sessions.createSession(userId);

    expect(session.expiresAt.getTime()).toBe(START.getTime() + config.absoluteLifetimeMs);
    expect(session.createdAt).toEqual(START);
    expect(session.revokedAt).toBeNull();
  });

  it('issues a distinct token per session', async () => {
    const first = await sessions.createSession(userId);
    const second = await sessions.createSession(userId);

    expect(first.token).not.toBe(second.token);
    expect(first.session.id).not.toBe(second.session.id);
  });
});

describe('session resolution', () => {
  it('authenticates a live session and returns identity only', async () => {
    const { token } = await sessions.createSession(userId);
    const resolution = await sessions.resolveSession(token);

    expect(resolution.ok).toBe(true);

    if (resolution.ok) {
      expect(resolution.identity.user.id).toBe(userId);
      expect(resolution.identity.user.email).toBe('owner@example.test');
      // Nothing organization-shaped is reachable from an authenticated identity.
      expect(Object.keys(resolution.identity)).toEqual(['user', 'session']);
      expect(resolution.identity).not.toHaveProperty('organizationId');
      expect(resolution.identity.user).not.toHaveProperty('memberships');
    }
  });

  it('reports no cookie rather than a failed lookup when none was presented', async () => {
    expect(await sessions.resolveSession(undefined)).toEqual({
      ok: false,
      reason: 'no_session_cookie',
    });
  });

  it('rejects a token that cannot have come from the generator', async () => {
    expect(await sessions.resolveSession("' OR 1=1--")).toEqual({
      ok: false,
      reason: 'session_not_found',
    });
  });

  it('rejects an unknown token', async () => {
    expect(await sessions.resolveSession('a'.repeat(43))).toEqual({
      ok: false,
      reason: 'session_not_found',
    });
  });

  it('rejects a session past its absolute lifetime, however active', async () => {
    const { token } = await sessions.createSession(userId);

    // Kept warm right up to the absolute limit, then one step past it.
    const step = 60 * 60 * 1_000;

    for (let elapsed = step; elapsed < config.absoluteLifetimeMs; elapsed += step) {
      advance(step);
      expect((await sessions.resolveSession(token)).ok).toBe(true);
    }

    advance(step);
    expect(await sessions.resolveSession(token)).toEqual({
      ok: false,
      reason: 'session_not_found',
    });
  });

  it('rejects a session past its idle window', async () => {
    const { token } = await sessions.createSession(userId);

    advance(config.idleTimeoutMs + 1_000);

    expect(await sessions.resolveSession(token)).toEqual({
      ok: false,
      reason: 'session_idle_expired',
    });
  });

  it('revokes an idle-expired session so it cannot be revived', async () => {
    const { token, session } = await sessions.createSession(userId);
    advance(config.idleTimeoutMs + 1_000);

    await sessions.resolveSession(token);

    expect(store.allSessions().find((row) => row.id === session.id)?.revokedAt).not.toBeNull();
    expect((await sessions.resolveSession(token)).ok).toBe(false);
  });

  it('keeps a session alive while it is used inside the idle window', async () => {
    const { token } = await sessions.createSession(userId);

    // Six near-idle-limit steps stay comfortably inside the 12-hour absolute limit.
    for (let step = 0; step < 6; step += 1) {
      advance(config.idleTimeoutMs - 60_000);
      expect((await sessions.resolveSession(token)).ok).toBe(true);
    }
  });

  it('rejects a revoked session', async () => {
    const { token, session } = await sessions.createSession(userId);
    await sessions.revokeById(session.id);

    expect(await sessions.resolveSession(token)).toEqual({
      ok: false,
      reason: 'session_not_found',
    });
  });

  it('records activity at most once per touch interval', async () => {
    const { token, session } = await sessions.createSession(userId);

    advance(30_000);
    await sessions.resolveSession(token);
    expect(store.allSessions().find((row) => row.id === session.id)?.lastUsedAt).toEqual(START);

    advance(31_000);
    await sessions.resolveSession(token);
    expect(store.allSessions().find((row) => row.id === session.id)?.lastUsedAt).toEqual(clock);
  });
});

describe('session rotation', () => {
  it('issues a new token and invalidates the old one', async () => {
    const original = await sessions.createSession(userId);
    advance(60_000);

    const rotated = await sessions.rotateSession(original.token);

    expect(rotated).not.toBeNull();
    expect(rotated?.token).not.toBe(original.token);
    expect((await sessions.resolveSession(original.token)).ok).toBe(false);
    expect((await sessions.resolveSession(rotated?.token ?? '')).ok).toBe(true);
  });

  it('keeps the same user', async () => {
    const original = await sessions.createSession(userId);
    const rotated = await sessions.rotateSession(original.token);

    expect(rotated?.session.userId).toBe(userId);
    expect(rotated?.session.id).not.toBe(original.session.id);
  });

  it('restarts the absolute lifetime from the rotation', async () => {
    const original = await sessions.createSession(userId);
    advance(60 * 60 * 1_000);

    const rotated = await sessions.rotateSession(original.token);

    expect(rotated?.session.expiresAt.getTime()).toBe(clock.getTime() + config.absoluteLifetimeMs);
  });

  it('does nothing for a token that is not live', async () => {
    expect(await sessions.rotateSession('a'.repeat(43))).toBeNull();
  });
});

describe('session revocation', () => {
  it('revokes by token', async () => {
    const { token } = await sessions.createSession(userId);

    expect(await sessions.revokeByToken(token)).toBe(true);
    expect((await sessions.resolveSession(token)).ok).toBe(false);
  });

  it('is idempotent — revoking twice is not an error', async () => {
    const { token } = await sessions.createSession(userId);

    expect(await sessions.revokeByToken(token)).toBe(true);
    expect(await sessions.revokeByToken(token)).toBe(false);
  });

  it('tolerates an absent or malformed token', async () => {
    expect(await sessions.revokeByToken(undefined)).toBe(false);
    expect(await sessions.revokeByToken('')).toBe(false);
    expect(await sessions.revokeByToken('nonsense')).toBe(false);
  });

  it('revokes every session a user holds', async () => {
    const tokens = await Promise.all([
      sessions.createSession(userId),
      sessions.createSession(userId),
      sessions.createSession(userId),
    ]);

    const other = store.addUser({
      email: 'other@example.test',
      name: 'Other',
      passwordHash: null,
      isPlatformAdmin: false,
    });
    const untouched = await sessions.createSession(other.id);

    expect(await sessions.revokeAllForUser(userId)).toBe(3);

    for (const issued of tokens) {
      expect((await sessions.resolveSession(issued.token)).ok).toBe(false);
    }

    // Another user's sessions are unaffected.
    expect((await sessions.resolveSession(untouched.token)).ok).toBe(true);
  });
});

describe('session cleanup', () => {
  it('removes finished sessions once past the grace window', async () => {
    const revoked = await sessions.createSession(userId);
    await sessions.revokeByToken(revoked.token);

    const live = await sessions.createSession(userId);

    advance(config.cleanupGraceMs + config.absoluteLifetimeMs + 1_000);

    expect(await sessions.cleanupFinishedSessions()).toBe(2);
    expect(store.allSessions()).toHaveLength(0);
    expect((await sessions.resolveSession(live.token)).ok).toBe(false);
  });

  it('keeps live sessions and recently finished ones', async () => {
    const live = await sessions.createSession(userId);
    const revoked = await sessions.createSession(userId);
    await sessions.revokeByToken(revoked.token);

    advance(60_000);

    expect(await sessions.cleanupFinishedSessions()).toBe(0);
    expect(store.allSessions()).toHaveLength(2);
    expect((await sessions.resolveSession(live.token)).ok).toBe(true);
  });
});
