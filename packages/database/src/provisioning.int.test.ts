import { createPasswordHasher } from '@organic-os/auth';
import { isAuthorizationError, type AuthenticatedIdentityRef } from '@organic-os/authorization';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createMembershipStore } from './authorization/membership-store.js';
import {
  createAuthorizationService,
  type AuthorizationService,
} from './authorization/with-authorized-organization.js';
import {
  isProvisioningError,
  provisionFirstOrganization,
  provisionUser,
  type ProvisionFirstOrganizationResult,
} from './provisioning.js';
import { createTestDatabase, type TestDatabase } from './testing/database.js';

/**
 * First-organization provisioning against real PostgreSQL.
 *
 * Three properties, and each of them is the reason the command exists in the shape it
 * does:
 *
 *   1. **Atomic.** Organization, first administrator and first `agency_admin`
 *      membership commit together or not at all. A tenant with no administrator
 *      cannot be repaired through the application, so it must never be committed.
 *   2. **Idempotent.** Keyed on the slug, so an operator who retries after a timeout
 *      gets the same identifiers instead of a second organization.
 *   3. **Privileged.** It needs the provisioning role. The runtime role — the one the
 *      API process holds — must fail, and the provisioning role must remain unable to
 *      perform DDL, bypass Row Level Security, or become a superuser.
 */

/** Cheap parameters: the hash is never verified here, only stored. */
const hasher = createPasswordHasher({ memoryCost: 8_192, timeCost: 1, parallelism: 1 });

let database: TestDatabase;
let authorization: AuthorizationService;
let passwordHash: string;

beforeAll(async () => {
  database = await createTestDatabase(inject('postgresAdminUri'), 'organic_os_provisioning_test');
  passwordHash = await hasher.hash('correct horse battery staple');

  authorization = createAuthorizationService({
    db: database.runtime.db,
    store: createMembershipStore(database.runtime.db),
  });
}, 240_000);

afterAll(async () => {
  await database?.close();
});

async function organizationCount(slug: string): Promise<number> {
  const result = await database.provisioner.db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM organizations WHERE slug = ${slug}`,
  );

  return Number(result.rows[0]?.count ?? '-1');
}

async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error: unknown) {
    if (isProvisioningError(error)) {
      return error.failure;
    }

    throw error;
  }

  return '(no failure)';
}

describe('creating an organization with a new administrator', () => {
  let result: ProvisionFirstOrganizationResult;

  it('creates the user, the organization and the first membership together', async () => {
    result = await provisionFirstOrganization(database.provisioner.db, {
      organization: { name: 'Provisioned Agency', slug: 'provisioned-agency' },
      admin: {
        kind: 'new_user',
        email: 'Founder@Example.Test',
        name: 'Founder',
        passwordHash,
      },
    });

    expect(result.created).toBe(true);
    expect(result.organizationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.membershipId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns no secret of any kind', () => {
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('argon2');
    expect(serialized).not.toContain(passwordHash);
    expect(Object.keys(result).sort()).toEqual(
      ['created', 'membershipId', 'organizationId', 'organizationSlug', 'userId'].sort(),
    );
  });

  it('normalises the address, so the account it created can authenticate', async () => {
    const rows = await database.provisioner.db.execute<{ email: string }>(
      sql`SELECT email::text AS email FROM users WHERE id = ${result.userId}`,
    );

    expect(rows.rows[0]?.email).toBe('founder@example.test');
  });

  it('makes the first membership an agency_admin reaching every client', async () => {
    const rows = await database.provisioner.db.execute<{
      role: string;
      client_access_mode: string;
    }>(
      sql`SELECT role::text AS role, client_access_mode::text AS client_access_mode
          FROM memberships WHERE id = ${result.membershipId}`,
    );

    expect(rows.rows[0]).toEqual({ role: 'agency_admin', client_access_mode: 'all_clients' });
  });

  it('grants no platform administration', async () => {
    const rows = await database.provisioner.db.execute<{ is_platform_admin: boolean }>(
      sql`SELECT is_platform_admin FROM users WHERE id = ${result.userId}`,
    );

    expect(rows.rows[0]?.is_platform_admin).toBe(false);
  });

  it('produces an organization the ordinary authorization path can use immediately', async () => {
    const identity: AuthenticatedIdentityRef = { userId: result.userId };

    const organizations = await authorization.listOrganizations(identity);
    expect(organizations.map((row) => row.organizationId)).toEqual([result.organizationId]);

    const role = await authorization.withAuthorizedOrganization(
      identity,
      result.organizationId,
      async (session) => {
        session.require('member.read');
        session.require('client.create');
        return Promise.resolve(session.context.role);
      },
    );

    expect(role).toBe('agency_admin');
  });
});

describe('idempotency', () => {
  it('returns the same identifiers on a retry and creates nothing', async () => {
    const first = await provisionFirstOrganization(database.provisioner.db, {
      organization: { name: 'Retry Agency', slug: 'retry-agency' },
      admin: { kind: 'new_user', email: 'retry@example.test', name: 'Retry', passwordHash },
    });

    const second = await provisionFirstOrganization(database.provisioner.db, {
      organization: { name: 'Retry Agency', slug: 'retry-agency' },
      admin: { kind: 'existing_user', email: 'retry@example.test' },
    });

    expect(second.created).toBe(false);
    expect(second.organizationId).toBe(first.organizationId);
    expect(second.membershipId).toBe(first.membershipId);
    expect(second.userId).toBe(first.userId);
    expect(await organizationCount('retry-agency')).toBe(1);
  });

  it('does not deduplicate on the display name, which may legitimately repeat', async () => {
    const first = await provisionFirstOrganization(database.provisioner.db, {
      organization: { name: 'Acme', slug: 'acme-north' },
      admin: { kind: 'new_user', email: 'acme-north@example.test', name: 'North', passwordHash },
    });

    const second = await provisionFirstOrganization(database.provisioner.db, {
      organization: { name: 'Acme', slug: 'acme-south' },
      admin: { kind: 'new_user', email: 'acme-south@example.test', name: 'South', passwordHash },
    });

    expect(second.created).toBe(true);
    expect(second.organizationId).not.toBe(first.organizationId);
  });

  it('refuses a slug that belongs to a different administrator', async () => {
    await provisionUser(database.provisioner.db, {
      email: 'intruder@example.test',
      name: 'Intruder',
    });

    expect(
      await failureOf(() =>
        provisionFirstOrganization(database.provisioner.db, {
          organization: { name: 'Retry Agency', slug: 'retry-agency' },
          admin: { kind: 'existing_user', email: 'intruder@example.test' },
        }),
      ),
    ).toBe('organization_slug_taken');

    // And no membership was granted to them.
    const rows = await database.provisioner.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM memberships m
          JOIN users u ON u.id = m.user_id
          WHERE u.email = 'intruder@example.test'`,
    );

    expect(rows.rows[0]?.count).toBe('0');
  });
});

describe('atomicity', () => {
  it('rolls the organization back when the administrator does not exist', async () => {
    expect(
      await failureOf(() =>
        provisionFirstOrganization(database.provisioner.db, {
          organization: { name: 'Doomed Agency', slug: 'doomed-agency' },
          admin: { kind: 'existing_user', email: 'nobody-at-all@example.test' },
        }),
      ),
    ).toBe('user_not_registered');

    // The organization insert happened before the failure, so this is the assertion
    // that matters: no tenant without an administrator survives.
    expect(await organizationCount('doomed-agency')).toBe(0);
  });

  it('rolls back when the address already has an account and creation was asked for', async () => {
    expect(
      await failureOf(() =>
        provisionFirstOrganization(database.provisioner.db, {
          organization: { name: 'Duplicate Agency', slug: 'duplicate-agency' },
          admin: {
            kind: 'new_user',
            email: 'retry@example.test',
            name: 'Retry Again',
            passwordHash,
          },
        }),
      ),
    ).toBe('user_already_registered');

    expect(await organizationCount('duplicate-agency')).toBe(0);
  });

  it('leaves no organization without an agency admin anywhere in the database', async () => {
    const rows = await database.provisioner.db.execute<{ slug: string }>(
      sql`SELECT o.slug::text AS slug
          FROM organizations o
          WHERE NOT EXISTS (
            SELECT 1 FROM memberships m
            WHERE m.organization_id = o.id AND m.role = 'agency_admin'
          )`,
    );

    expect(rows.rows).toEqual([]);
  });
});

describe('input validation', () => {
  it('refuses a slug the schema would reject, without touching the database', async () => {
    for (const slug of ['', 'A', 'has spaces', 'Uppercase', '-leading', 'x']) {
      expect(
        await failureOf(() =>
          provisionFirstOrganization(database.provisioner.db, {
            organization: { name: 'Invalid', slug },
            admin: { kind: 'existing_user', email: 'retry@example.test' },
          }),
        ),
      ).toBe('invalid_input');
    }
  });

  it('refuses an empty name and a malformed address', async () => {
    expect(
      await failureOf(() =>
        provisionFirstOrganization(database.provisioner.db, {
          organization: { name: '   ', slug: 'blank-name' },
          admin: { kind: 'existing_user', email: 'retry@example.test' },
        }),
      ),
    ).toBe('invalid_input');

    expect(
      await failureOf(() =>
        provisionFirstOrganization(database.provisioner.db, {
          organization: { name: 'Fine', slug: 'bad-address' },
          admin: { kind: 'existing_user', email: 'not-an-address' },
        }),
      ),
    ).toBe('invalid_input');

    expect(await organizationCount('blank-name')).toBe(0);
    expect(await organizationCount('bad-address')).toBe(0);
  });
});

describe('the provisioning boundary', () => {
  it('refuses the runtime role, which is the role the API process holds', async () => {
    await expect(
      provisionFirstOrganization(database.runtime.db, {
        organization: { name: 'Runtime Attempt', slug: 'runtime-attempt' },
        admin: { kind: 'existing_user', email: 'retry@example.test' },
      }),
    ).rejects.toThrow();

    expect(await organizationCount('runtime-attempt')).toBe(0);
  });

  it('leaves the provisioning role without superuser, BYPASSRLS or role creation', async () => {
    const rows = await database.provisioner.db.execute<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
    }>(
      sql`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
          FROM pg_roles WHERE rolname = 'organic_os_provisioner'`,
    );

    expect(rows.rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });
  });

  it('leaves the provisioning role unable to perform DDL', async () => {
    await expect(
      database.provisioner.db.execute(sql`CREATE TABLE provisioner_ddl_probe (id uuid)`),
    ).rejects.toThrow();

    await expect(
      database.provisioner.db.execute(sql`ALTER TABLE memberships ADD COLUMN probe text`),
    ).rejects.toThrow();
  });

  it('leaves the runtime role unable to see another organization after provisioning', async () => {
    const outsider = await provisionFirstOrganization(database.provisioner.db, {
      organization: { name: 'Neighbour', slug: 'neighbour' },
      admin: { kind: 'new_user', email: 'neighbour@example.test', name: 'Neighbour', passwordHash },
    });

    const stranger = await provisionFirstOrganization(database.provisioner.db, {
      organization: { name: 'Stranger', slug: 'stranger' },
      admin: { kind: 'new_user', email: 'stranger@example.test', name: 'Stranger', passwordHash },
    });

    let failure = '(none)';

    try {
      await authorization.withAuthorizedOrganization(
        { userId: outsider.userId },
        stranger.organizationId,
        async () => Promise.resolve(null),
      );
    } catch (error: unknown) {
      failure = isAuthorizationError(error) ? error.failure : 'unexpected';
    }

    expect(failure).toBe('no_membership');
  });
});
