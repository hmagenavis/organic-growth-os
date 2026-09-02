import { isAuthorizationError, type AuthenticatedIdentityRef } from '@organic-os/authorization';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { AdministrationRequest } from '../administration/membership-administration.js';
import { createMembershipStore } from '../authorization/membership-store.js';
import {
  createAuthorizationService,
  type AuthorizationService,
  type AuthorizedOrganizationSession,
} from '../authorization/with-authorized-organization.js';
import { provisionMembership, provisionOrganization, provisionUser } from '../provisioning.js';
import type { AuditLogRecord } from '../repositories/audit-logs.js';
import {
  isInvalidSiteCursorError,
  isSiteBaseUrlConflictError,
  type SiteRecord,
} from '../repositories/sites.js';
import type { MembershipRole } from '../schema/enums.js';
import type { TenantContext } from '../tenant/context.js';
import { withTenantTransaction } from '../tenant/with-tenant-transaction.js';
import { createTestDatabase, type TestDatabase } from '../testing/database.js';
import { isSiteInputError } from './normalize.js';
import { createSiteService, type SiteService } from './site-service.js';

/**
 * The site API's decisions, against real PostgreSQL.
 *
 * Two properties are proven here, and they are what sub-phase 0.4.2B2 exists for:
 *
 *   1. **authorized = site permission AND parent-client access.** There is no
 *      site-level scope table; a site is reachable exactly when its client is.
 *   2. **every site created through this service starts with a real `site_settings`
 *      row in `review`,** written in the same transaction as the site and its audit
 *      record — so a site with no settings, or a site that began in a more permissive
 *      autopilot mode, cannot be committed.
 *
 * Everything runs through the code a deployment runs, as the runtime role, with
 * `FORCE ROW LEVEL SECURITY` on and the real grants. The HTTP mapping is tested next
 * door in `apps/api`; nothing here goes through Fastify.
 */

const REQUEST: AdministrationRequest = { source: 'api', ip: '198.51.100.10' };

let database: TestDatabase;
let authorization: AuthorizationService;
let sites: SiteService;

interface Actor {
  userId: string;
  membershipId: string;
}

interface Fixture {
  orgA: string;
  orgB: string;
  /** Client A1 — reachable by everyone with `all_clients`, and by `viewer`. */
  cA1: string;
  /** Client A2 — the only client `scopedAdmin` may reach. */
  cA2: string;
  /** Sites of A1, in creation order. */
  s1: string;
  s2: string;
  s3: string;
  s4: string;
  s5: string;
  /** The single site of A2. */
  s2a: string;
  cB1: string;
  sB1: string;
  admin: Actor;
  scopedAdmin: Actor;
  manager: Actor;
  editor: Actor;
  analyst: Actor;
  viewer: Actor;
  emptyViewer: Actor;
  platformAdmin: Actor;
  foreignAdmin: Actor;
}

let fixture: Fixture;

function identity(actor: Actor): AuthenticatedIdentityRef {
  return { userId: actor.userId };
}

async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error: unknown) {
    if (isAuthorizationError(error)) {
      return error.failure;
    }

    throw error;
  }

  return '(no failure)';
}

/** Asserts a rejection and its kind, without relying on a matcher for the predicate. */
async function expectRejection(
  run: () => Promise<unknown>,
  guard: (error: unknown) => boolean,
): Promise<void> {
  let threw = false;
  let thrown: unknown = null;

  try {
    await run();
  } catch (error: unknown) {
    threw = true;
    thrown = error;
  }

  expect(threw).toBe(true);
  expect(guard(thrown)).toBe(true);
}

async function listIds(
  actor: Actor,
  organizationId: string,
  clientId: string,
  limit = 50,
): Promise<string[]> {
  const page = await sites.listSites(identity(actor), organizationId, clientId, { limit });
  return page.sites.map((site) => site.id);
}

async function auditRows(organizationId: string, userId: string): Promise<AuditLogRecord[]> {
  const tenant: TenantContext = { organizationId, actor: { kind: 'user', userId } };

  return withTenantTransaction(database.runtime.db, tenant, async (repositories) =>
    repositories.auditLogs.list(1000),
  );
}

async function auditFor(targetId: string): Promise<AuditLogRecord[]> {
  const rows = await auditRows(fixture.orgA, fixture.admin.userId);
  return rows.filter((row) => row.targetId === targetId);
}

/** Every site row of an organization, read straight from the tenant repository. */
async function allSites(organizationId: string, userId: string): Promise<SiteRecord[]> {
  const tenant: TenantContext = { organizationId, actor: { kind: 'user', userId } };

  return withTenantTransaction(database.runtime.db, tenant, async (repositories) =>
    repositories.sites.list(),
  );
}

async function settingsOf(siteId: string): Promise<{ autopilotMode: string } | null> {
  const tenant: TenantContext = {
    organizationId: fixture.orgA,
    actor: { kind: 'user', userId: fixture.admin.userId },
  };

  return withTenantTransaction(database.runtime.db, tenant, async (repositories) => {
    const row = await repositories.siteSettings.findBySiteId(siteId);
    return row === null ? null : { autopilotMode: row.autopilotMode };
  });
}

/**
 * The real authorization service with one repository replaced.
 *
 * Test-only composition of production interfaces — there is no seam in the service
 * itself, and there must not be one: a hook that lets a caller substitute the
 * settings repository is a hook that lets a caller skip it. Wrapping from outside
 * gives the same failure without weakening the thing under test.
 */
function authorizationWith(
  decorate: (session: AuthorizedOrganizationSession) => AuthorizedOrganizationSession,
): AuthorizationService {
  return {
    listOrganizations: (actorIdentity) => authorization.listOrganizations(actorIdentity),
    withAuthorizedOrganization: <T>(
      actorIdentity: AuthenticatedIdentityRef,
      organizationId: string,
      fn: (session: AuthorizedOrganizationSession) => Promise<T>,
    ): Promise<T> =>
      authorization.withAuthorizedOrganization(actorIdentity, organizationId, (session) =>
        fn(decorate(session)),
      ),
  };
}

beforeAll(async () => {
  database = await createTestDatabase(inject('postgresAdminUri'), 'organic_os_site_service_test');

  const provisioner = database.provisioner.db;

  const organizationA = await provisionOrganization(provisioner, {
    name: 'Site Service A',
    slug: 'site-service-a',
  });
  const organizationB = await provisionOrganization(provisioner, {
    name: 'Site Service B',
    slug: 'site-service-b',
  });

  async function actor(
    organizationId: string | null,
    handle: string,
    role: MembershipRole,
    clientAccessMode: 'all_clients' | 'scoped',
    isPlatformAdmin = false,
  ): Promise<Actor> {
    const user = await provisionUser(provisioner, {
      email: `${handle}@example.test`,
      name: handle,
      isPlatformAdmin,
    });

    if (organizationId === null) {
      return { userId: user.id, membershipId: '' };
    }

    const membership = await provisionMembership(provisioner, {
      organizationId,
      userId: user.id,
      role,
      clientAccessMode,
    });

    return { userId: user.id, membershipId: membership.id };
  }

  const admin = await actor(organizationA.id, 'ss-admin', 'agency_admin', 'all_clients');
  const scopedAdmin = await actor(organizationA.id, 'ss-admin-scoped', 'agency_admin', 'scoped');
  const manager = await actor(organizationA.id, 'ss-manager', 'seo_manager', 'all_clients');
  const editor = await actor(organizationA.id, 'ss-editor', 'content_editor', 'all_clients');
  const analystActor = await actor(organizationA.id, 'ss-analyst', 'analyst', 'all_clients');
  const viewer = await actor(organizationA.id, 'ss-viewer', 'client_viewer', 'scoped');
  const emptyViewer = await actor(organizationA.id, 'ss-viewer-empty', 'client_viewer', 'scoped');
  const platformAdmin = await actor(
    organizationB.id,
    'ss-platform',
    'agency_admin',
    'all_clients',
    true,
  );
  const foreignAdmin = await actor(organizationB.id, 'ss-foreign', 'agency_admin', 'all_clients');

  const tenantA: TenantContext = {
    organizationId: organizationA.id,
    actor: { kind: 'user', userId: admin.userId },
  };
  const tenantB: TenantContext = {
    organizationId: organizationB.id,
    actor: { kind: 'user', userId: foreignAdmin.userId },
  };

  const { cA1, cA2 } = await withTenantTransaction(
    database.runtime.db,
    tenantA,
    async (repositories) => ({
      cA1: (await repositories.clients.create({ name: 'Site Client A1' })).id,
      cA2: (await repositories.clients.create({ name: 'Site Client A2' })).id,
    }),
  );

  await withTenantTransaction(database.runtime.db, tenantA, async (repositories) => {
    await repositories.membershipClientScopes.add({
      membershipId: viewer.membershipId,
      clientId: cA1,
    });
    await repositories.membershipClientScopes.add({
      membershipId: scopedAdmin.membershipId,
      clientId: cA2,
    });
  });

  const cB1 = await withTenantTransaction(
    database.runtime.db,
    tenantB,
    async (repositories) => (await repositories.clients.create({ name: 'Site Client B1' })).id,
  );

  authorization = createAuthorizationService({
    db: database.runtime.db,
    store: createMembershipStore(database.runtime.db),
  });
  sites = createSiteService({ authorization });

  // Created through the service, one transaction at a time, so `created_at` strictly
  // increases and every fixture site also carries the settings row the invariant test
  // asserts.
  const created: string[] = [];

  for (const index of [1, 2, 3, 4, 5]) {
    const site = await sites.createSite(
      identity(admin),
      organizationA.id,
      cA1,
      { baseUrl: `https://a1-${index}.example.test` },
      REQUEST,
    );
    created.push(site.id);
  }

  const [s1, s2, s3, s4, s5] = created;

  const s2a = (
    await sites.createSite(
      identity(admin),
      organizationA.id,
      cA2,
      { baseUrl: 'https://a2-1.example.test' },
      REQUEST,
    )
  ).id;

  const sB1 = (
    await sites.createSite(
      identity(foreignAdmin),
      organizationB.id,
      cB1,
      { baseUrl: 'https://b1-1.example.test' },
      REQUEST,
    )
  ).id;

  if (
    s1 === undefined ||
    s2 === undefined ||
    s3 === undefined ||
    s4 === undefined ||
    s5 === undefined
  ) {
    throw new Error('fixture did not create five sites');
  }

  fixture = {
    orgA: organizationA.id,
    orgB: organizationB.id,
    cA1,
    cA2,
    s1,
    s2,
    s3,
    s4,
    s5,
    s2a,
    cB1,
    sB1,
    admin,
    scopedAdmin,
    manager,
    editor,
    analyst: analystActor,
    viewer,
    emptyViewer,
    platformAdmin,
    foreignAdmin,
  };
}, 240_000);

afterAll(async () => {
  await database?.close();
});

describe('reading requires the site permission AND the parent client access', () => {
  it('lists every site of a reachable client for an all_clients membership', async () => {
    expect(await listIds(fixture.admin, fixture.orgA, fixture.cA1)).toEqual([
      fixture.s1,
      fixture.s2,
      fixture.s3,
      fixture.s4,
      fixture.s5,
    ]);
    expect(await listIds(fixture.admin, fixture.orgA, fixture.cA2)).toEqual([fixture.s2a]);
  });

  it('gets a single site of a reachable client', async () => {
    const site = await sites.getSite(
      identity(fixture.admin),
      fixture.orgA,
      fixture.cA1,
      fixture.s3,
    );

    expect(site.id).toBe(fixture.s3);
    expect(site.baseUrl).toBe('https://a1-3.example.test');
    expect(site.autopilotMode).toBe('review');
    expect(site.cmsType).toBe('wordpress');
    expect(site.status).toBe('active');
  });

  it('lets a scoped agency admin reach its own client and no other', async () => {
    expect(await listIds(fixture.scopedAdmin, fixture.orgA, fixture.cA2)).toEqual([fixture.s2a]);

    expect(await failureOf(() => listIds(fixture.scopedAdmin, fixture.orgA, fixture.cA1))).toBe(
      'client_out_of_scope',
    );
    expect(
      await failureOf(() =>
        sites.getSite(identity(fixture.scopedAdmin), fixture.orgA, fixture.cA1, fixture.s1),
      ),
    ).toBe('client_out_of_scope');
  });

  it.each(['manager', 'editor', 'analyst'] as const)(
    'lets a read-only role (%s) read the sites under a client it may reach',
    async (role) => {
      expect(await listIds(fixture[role], fixture.orgA, fixture.cA1)).toHaveLength(5);
      expect(
        (await sites.getSite(identity(fixture[role]), fixture.orgA, fixture.cA1, fixture.s1)).id,
      ).toBe(fixture.s1);
    },
  );

  it('gives a client_viewer only the sites under its explicitly scoped client', async () => {
    expect(await listIds(fixture.viewer, fixture.orgA, fixture.cA1)).toHaveLength(5);

    expect(await failureOf(() => listIds(fixture.viewer, fixture.orgA, fixture.cA2))).toBe(
      'client_out_of_scope',
    );
  });

  it('gives a scoped membership with zero scope rows exactly zero reachable sites', async () => {
    // The property ADR-0016 exists for: an empty scope collection is not "all".
    for (const clientId of [fixture.cA1, fixture.cA2]) {
      expect(await failureOf(() => listIds(fixture.emptyViewer, fixture.orgA, clientId))).toBe(
        'client_out_of_scope',
      );
    }
  });

  it('refuses a malformed or unknown site id as if it did not exist', async () => {
    for (const siteId of ['not-a-uuid', '018f9e1a-0000-7000-8000-00000000dead']) {
      expect(
        await failureOf(() =>
          sites.getSite(identity(fixture.admin), fixture.orgA, fixture.cA1, siteId),
        ),
      ).toBe('resource_not_in_organization');
    }
  });

  it('refuses a real site paired with the wrong parent client', async () => {
    // The single most important non-enumeration case for a nested resource: the site
    // exists, the client exists, the caller may reach both — and the pairing is still
    // refused, identically to a site that does not exist.
    expect(
      await failureOf(() =>
        sites.getSite(identity(fixture.admin), fixture.orgA, fixture.cA2, fixture.s1),
      ),
    ).toBe('resource_not_in_organization');
  });

  it('does not leak sites of one client into another client listing', async () => {
    const a1 = await listIds(fixture.admin, fixture.orgA, fixture.cA1);
    expect(a1).not.toContain(fixture.s2a);
  });
});

describe('cross-tenant access is impossible in either direction', () => {
  it('refuses to list sites of another organization', async () => {
    expect(await failureOf(() => listIds(fixture.admin, fixture.orgB, fixture.cB1))).toBe(
      'no_membership',
    );
    expect(await failureOf(() => listIds(fixture.foreignAdmin, fixture.orgA, fixture.cA1))).toBe(
      'no_membership',
    );
  });

  it('reads a foreign client id as absent rather than forbidden', async () => {
    expect(await failureOf(() => listIds(fixture.admin, fixture.orgA, fixture.cB1))).toBe(
      'resource_not_in_organization',
    );
  });

  it('reads a foreign site id as absent even under a reachable client', async () => {
    expect(
      await failureOf(() =>
        sites.getSite(identity(fixture.admin), fixture.orgA, fixture.cA1, fixture.sB1),
      ),
    ).toBe('resource_not_in_organization');
  });

  it('refuses to create a site in another organization', async () => {
    expect(
      await failureOf(() =>
        sites.createSite(
          identity(fixture.admin),
          fixture.orgB,
          fixture.cB1,
          { baseUrl: 'https://intruder.example.test' },
          REQUEST,
        ),
      ),
    ).toBe('no_membership');
  });

  it('refuses to patch a site of another organization', async () => {
    expect(
      await failureOf(() =>
        sites.updateSite(
          identity(fixture.admin),
          fixture.orgB,
          fixture.cB1,
          fixture.sB1,
          { timezone: 'UTC' },
          REQUEST,
        ),
      ),
    ).toBe('no_membership');
  });

  it('does not let a platform administrator bypass organization membership', async () => {
    // `is_platform_admin` is not an organization role and grants no tenant authority
    // (docs/SECURITY.md §3). The same user is an ordinary agency_admin in its own
    // organization, which is what makes the refusal in A meaningful.
    expect(await failureOf(() => listIds(fixture.platformAdmin, fixture.orgA, fixture.cA1))).toBe(
      'no_membership',
    );
    expect(
      await failureOf(() =>
        sites.getSite(identity(fixture.platformAdmin), fixture.orgA, fixture.cA1, fixture.s1),
      ),
    ).toBe('no_membership');
    expect(
      await failureOf(() =>
        sites.createSite(
          identity(fixture.platformAdmin),
          fixture.orgA,
          fixture.cA1,
          { baseUrl: 'https://platform.example.test' },
          REQUEST,
        ),
      ),
    ).toBe('no_membership');

    expect(await listIds(fixture.platformAdmin, fixture.orgB, fixture.cB1)).toEqual([fixture.sB1]);
  });
});

describe('creating is agency_admin AND in scope', () => {
  it.each(['manager', 'editor', 'analyst', 'viewer'] as const)(
    'refuses %s the create it does not hold, before any site is read',
    async (role) => {
      expect(
        await failureOf(() =>
          sites.createSite(
            identity(fixture[role]),
            fixture.orgA,
            fixture.cA1,
            { baseUrl: 'https://denied.example.test' },
            REQUEST,
          ),
        ),
      ).toBe('permission_denied');
    },
  );

  it('takes the organization and the client from context, never from an argument', async () => {
    const created = await sites.createSite(
      identity(fixture.admin),
      fixture.orgA,
      fixture.cA1,
      { baseUrl: 'https://ownership.example.test' },
      REQUEST,
    );

    const rows = await allSites(fixture.orgA, fixture.admin.userId);
    const stored = rows.find((row) => row.id === created.id);

    expect(stored?.organizationId).toBe(fixture.orgA);
    expect(stored?.clientId).toBe(fixture.cA1);
  });

  it('normalizes the base URL before storing it', async () => {
    const created = await sites.createSite(
      identity(fixture.admin),
      fixture.orgA,
      fixture.cA1,
      { baseUrl: '  HTTPS://Normalized.Example.Test:443/blog/  ', timezone: 'asia/jerusalem' },
      REQUEST,
    );

    expect(created.baseUrl).toBe('https://normalized.example.test/blog');
    expect(created.timezone).toBe('Asia/Jerusalem');
  });

  it('refuses a base URL it cannot normalize and stores nothing', async () => {
    const before = (await allSites(fixture.orgA, fixture.admin.userId)).length;

    await expectRejection(
      () =>
        sites.createSite(
          identity(fixture.admin),
          fixture.orgA,
          fixture.cA1,
          { baseUrl: 'ftp://example.test' },
          REQUEST,
        ),
      isSiteInputError,
    );

    expect((await allSites(fixture.orgA, fixture.admin.userId)).length).toBe(before);
  });

  it('lets a scoped agency admin create only under its scoped client', async () => {
    expect(
      await failureOf(() =>
        sites.createSite(
          identity(fixture.scopedAdmin),
          fixture.orgA,
          fixture.cA1,
          { baseUrl: 'https://scoped-denied.example.test' },
          REQUEST,
        ),
      ),
    ).toBe('client_out_of_scope');

    const allowed = await sites.createSite(
      identity(fixture.scopedAdmin),
      fixture.orgA,
      fixture.cA2,
      { baseUrl: 'https://scoped-allowed.example.test' },
      REQUEST,
    );

    expect(allowed.autopilotMode).toBe('review');
  });

  it('writes exactly one audit record, with the settings decision recorded as policy', async () => {
    const created = await sites.createSite(
      identity(fixture.admin),
      fixture.orgA,
      fixture.cA1,
      { baseUrl: 'https://audited.example.test' },
      REQUEST,
    );

    const rows = await auditFor(created.id);

    expect(rows).toHaveLength(1);

    const row = rows[0];

    expect(row?.action).toBe('site.created');
    expect(row?.targetType).toBe('site');
    expect(row?.before).toBeNull();
    expect(row?.result).toBe('ok');
    expect(row?.source).toBe('api');
    expect(row?.actorId).toBe(fixture.admin.userId);
    expect(row?.actorMembershipId).toBe(fixture.admin.membershipId);
    expect(row?.after).toMatchObject({
      baseUrl: 'https://audited.example.test',
      cmsType: 'wordpress',
      status: 'active',
      clientId: fixture.cA1,
      autopilotMode: 'review',
      autopilotModeSource: 'system_policy',
    });
  });

  it('writes no audit record for a refused create', async () => {
    const before = (await auditRows(fixture.orgA, fixture.admin.userId)).length;

    await failureOf(() =>
      sites.createSite(
        identity(fixture.manager),
        fixture.orgA,
        fixture.cA1,
        { baseUrl: 'https://refused.example.test' },
        REQUEST,
      ),
    );
    await failureOf(() =>
      sites.createSite(
        identity(fixture.scopedAdmin),
        fixture.orgA,
        fixture.cA1,
        { baseUrl: 'https://refused-2.example.test' },
        REQUEST,
      ),
    );

    expect((await auditRows(fixture.orgA, fixture.admin.userId)).length).toBe(before);
  });
});

describe('the safe initial site_settings invariant', () => {
  it('gives every service-created site exactly one settings row in review', async () => {
    for (const siteId of [
      fixture.s1,
      fixture.s2,
      fixture.s3,
      fixture.s4,
      fixture.s5,
      fixture.s2a,
    ]) {
      expect(await settingsOf(siteId)).toEqual({ autopilotMode: 'review' });
    }
  });

  it('cannot store a second settings row for one site', async () => {
    // "Exactly one" is a database property, not an application convention:
    // `site_settings.site_id` is UNIQUE in migration 0001.
    const tenant: TenantContext = {
      organizationId: fixture.orgA,
      actor: { kind: 'user', userId: fixture.admin.userId },
    };

    await expect(
      withTenantTransaction(database.runtime.db, tenant, async (repositories) =>
        repositories.siteSettings.createForSite(fixture.s1),
      ),
    ).rejects.toThrow();

    expect(await settingsOf(fixture.s1)).toEqual({ autopilotMode: 'review' });
  });

  it('rolls the site back when its settings row cannot be written', async () => {
    const failing = createSiteService({
      authorization: authorizationWith((session) => ({
        ...session,
        repositories: {
          ...session.repositories,
          siteSettings: {
            ...session.repositories.siteSettings,
            createForSite: () => Promise.reject(new Error('settings insert failed')),
          },
        },
      })),
    });

    const baseUrl = 'https://rollback-settings.example.test';

    await expect(
      failing.createSite(identity(fixture.admin), fixture.orgA, fixture.cA1, { baseUrl }, REQUEST),
    ).rejects.toThrow('settings insert failed');

    const rows = await allSites(fixture.orgA, fixture.admin.userId);
    expect(rows.some((row) => row.baseUrl === baseUrl)).toBe(false);
  });

  it('rolls the site and its settings back when the audit record cannot be written', async () => {
    const failing = createSiteService({
      authorization: authorizationWith((session) => ({
        ...session,
        repositories: {
          ...session.repositories,
          auditLogs: {
            ...session.repositories.auditLogs,
            append: () => Promise.reject(new Error('audit insert failed')),
          },
        },
      })),
    });

    const baseUrl = 'https://rollback-audit.example.test';

    await expect(
      failing.createSite(identity(fixture.admin), fixture.orgA, fixture.cA1, { baseUrl }, REQUEST),
    ).rejects.toThrow('audit insert failed');

    const rows = await allSites(fixture.orgA, fixture.admin.userId);
    const orphan = rows.find((row) => row.baseUrl === baseUrl);

    expect(orphan).toBeUndefined();
  });
});

describe('the base URL uniqueness constraint is the concurrency authority', () => {
  it('refuses a duplicate base URL and leaves no site, settings or audit behind', async () => {
    const baseUrl = 'https://duplicate.example.test';

    const first = await sites.createSite(
      identity(fixture.admin),
      fixture.orgA,
      fixture.cA1,
      { baseUrl },
      REQUEST,
    );

    const auditBefore = (await auditRows(fixture.orgA, fixture.admin.userId)).length;

    await expectRejection(
      () =>
        sites.createSite(identity(fixture.admin), fixture.orgA, fixture.cA1, { baseUrl }, REQUEST),
      isSiteBaseUrlConflictError,
    );

    const rows = await allSites(fixture.orgA, fixture.admin.userId);
    expect(rows.filter((row) => row.baseUrl === baseUrl)).toHaveLength(1);
    expect(rows.filter((row) => row.baseUrl === baseUrl)[0]?.id).toBe(first.id);
    expect((await auditRows(fixture.orgA, fixture.admin.userId)).length).toBe(auditBefore);
  });

  it('treats two spellings of one URL as the same site', async () => {
    const baseUrl = 'https://spelling.example.test';

    await sites.createSite(
      identity(fixture.admin),
      fixture.orgA,
      fixture.cA1,
      { baseUrl },
      REQUEST,
    );

    await expectRejection(
      () =>
        sites.createSite(
          identity(fixture.admin),
          fixture.orgA,
          fixture.cA2,
          { baseUrl: 'HTTPS://Spelling.Example.Test/' },
          REQUEST,
        ),
      isSiteBaseUrlConflictError,
    );
  });
});

describe('updating is agency_admin AND in scope', () => {
  async function freshSite(clientId: string, slug: string): Promise<string> {
    const created = await sites.createSite(
      identity(fixture.admin),
      fixture.orgA,
      clientId,
      { baseUrl: `https://${slug}.example.test` },
      REQUEST,
    );

    return created.id;
  }

  it('records a correct before/after pair and audits exactly once', async () => {
    const siteId = await freshSite(fixture.cA1, 'update-target');

    const updated = await sites.updateSite(
      identity(fixture.admin),
      fixture.orgA,
      fixture.cA1,
      siteId,
      { baseUrl: 'https://update-target-2.example.test', language: 'he' },
      REQUEST,
    );

    expect(updated.baseUrl).toBe('https://update-target-2.example.test');
    expect(updated.language).toBe('he');
    expect(updated.autopilotMode).toBe('review');

    const rows = (await auditFor(siteId)).filter((row) => row.action === 'site.updated');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.before).toMatchObject({
      baseUrl: 'https://update-target.example.test',
      language: 'en',
    });
    expect(rows[0]?.after).toMatchObject({
      baseUrl: 'https://update-target-2.example.test',
      language: 'he',
    });
  });

  it('writes no audit row for a patch that changes nothing', async () => {
    const siteId = await freshSite(fixture.cA1, 'noop-target');
    const before = (await auditFor(siteId)).length;

    const unchanged = await sites.updateSite(
      identity(fixture.admin),
      fixture.orgA,
      fixture.cA1,
      siteId,
      // Different spelling, same normalized value.
      { baseUrl: 'https://noop-target.example.test/', timezone: 'UTC' },
      REQUEST,
    );

    expect(unchanged.autopilotMode).toBe('review');
    expect((await auditFor(siteId)).length).toBe(before);
  });

  it.each(['manager', 'editor', 'analyst', 'viewer'] as const)(
    'refuses %s the update it does not hold, whatever the site id',
    async (role) => {
      // The role check runs before any site is read, so a member that could never
      // update learns nothing about which sites exist.
      expect(
        await failureOf(() =>
          sites.updateSite(
            identity(fixture[role]),
            fixture.orgA,
            fixture.cA1,
            '018f9e1a-0000-7000-8000-00000000dead',
            { timezone: 'UTC' },
            REQUEST,
          ),
        ),
      ).toBe('permission_denied');
    },
  );

  it('refuses a scoped agency admin a site under an inaccessible client', async () => {
    expect(
      await failureOf(() =>
        sites.updateSite(
          identity(fixture.scopedAdmin),
          fixture.orgA,
          fixture.cA1,
          fixture.s1,
          { timezone: 'UTC' },
          REQUEST,
        ),
      ),
    ).toBe('client_out_of_scope');
  });

  it('refuses a site paired with the wrong parent client, and changes nothing', async () => {
    expect(
      await failureOf(() =>
        sites.updateSite(
          identity(fixture.admin),
          fixture.orgA,
          fixture.cA2,
          fixture.s1,
          { timezone: 'Europe/London' },
          REQUEST,
        ),
      ),
    ).toBe('resource_not_in_organization');

    const site = await sites.getSite(
      identity(fixture.admin),
      fixture.orgA,
      fixture.cA1,
      fixture.s1,
    );

    expect(site.timezone).toBe('UTC');
  });

  it('writes no audit row for a refused or failed mutation', async () => {
    const siteId = await freshSite(fixture.cA1, 'conflict-target');
    const before = (await auditFor(siteId)).length;

    // A real failure rather than a refusal: the target URL is already taken.
    await expectRejection(
      () =>
        sites.updateSite(
          identity(fixture.admin),
          fixture.orgA,
          fixture.cA1,
          siteId,
          { baseUrl: 'https://a1-1.example.test' },
          REQUEST,
        ),
      isSiteBaseUrlConflictError,
    );

    expect((await auditFor(siteId)).length).toBe(before);

    const unchanged = await sites.getSite(
      identity(fixture.admin),
      fixture.orgA,
      fixture.cA1,
      siteId,
    );

    expect(unchanged.baseUrl).toBe('https://conflict-target.example.test');
  });

  it('never changes the autopilot mode', async () => {
    const siteId = await freshSite(fixture.cA1, 'autopilot-untouched');

    await sites.updateSite(
      identity(fixture.admin),
      fixture.orgA,
      fixture.cA1,
      siteId,
      { timezone: 'Europe/London' },
      REQUEST,
    );

    expect(await settingsOf(siteId)).toEqual({ autopilotMode: 'review' });
  });
});

describe('pagination is bounded, ordered and authorization-aware', () => {
  it('walks every page of a client in a deterministic order without repeats or gaps', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page += 1) {
      const result = await sites.listSites(identity(fixture.viewer), fixture.orgA, fixture.cA1, {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });

      seen.push(...result.sites.map((site) => site.id));

      if (result.nextCursor === null) {
        break;
      }

      cursor = result.nextCursor;
    }

    const everything = await listIds(fixture.viewer, fixture.orgA, fixture.cA1, 100);

    expect(seen).toEqual(everything);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.slice(0, 5)).toEqual([fixture.s1, fixture.s2, fixture.s3, fixture.s4, fixture.s5]);
  });

  it('never returns a site of another client on any page', async () => {
    const all = await listIds(fixture.admin, fixture.orgA, fixture.cA1, 100);

    expect(all).not.toContain(fixture.s2a);
    expect(all).not.toContain(fixture.sB1);
  });

  it('refuses a cursor that is not a position in this ordering', async () => {
    for (const cursor of ['abc', Buffer.from('nope').toString('base64url'), '!!!']) {
      await expectRejection(
        () =>
          sites.listSites(identity(fixture.admin), fixture.orgA, fixture.cA1, {
            limit: 10,
            cursor,
          }),
        isInvalidSiteCursorError,
      );
    }
  });

  it('clamps a limit the repository is asked for directly', async () => {
    const tenant: TenantContext = {
      organizationId: fixture.orgA,
      actor: { kind: 'user', userId: fixture.admin.userId },
    };

    const page = await withTenantTransaction(database.runtime.db, tenant, async (repositories) =>
      repositories.sites.listAuthorizedPage(fixture.cA1, { limit: 10_000 }),
    );

    expect(page.sites.length).toBeLessThanOrEqual(100);
  });
});
