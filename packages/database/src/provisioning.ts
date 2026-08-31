import { eq } from 'drizzle-orm';

import type { Database } from './client.js';
import { newId } from './ids.js';
import { requireRow } from './repositories/util.js';
import { memberships, organizations, users } from './schema/index.js';
import type { MembershipRole } from './schema/enums.js';
import { runWithTenantContext } from './tenant/transaction.js';

/**
 * Tenant provisioning.
 *
 * Creating an organization or a user happens *before* any tenant context can exist,
 * so these operations cannot run through `withTenantTransaction`. They are therefore
 * privileged: they require a connection using the provisioning role, and the runtime
 * role is refused by the database itself (it holds no INSERT grant on `organizations`
 * or `users` — migration 0002). Passing a runtime handle here fails loudly rather
 * than silently succeeding.
 *
 * Nothing in this module is reachable from tenant-facing repositories.
 */

export type OrganizationRecord = typeof organizations.$inferSelect;
export type UserRecord = typeof users.$inferSelect;
export type MembershipRecord = typeof memberships.$inferSelect;

export interface ProvisionOrganizationInput {
  name: string;
  /** Lowercase, URL-safe; unique across the platform. */
  slug: string;
}

export async function provisionOrganization(
  db: Database,
  input: ProvisionOrganizationInput,
): Promise<OrganizationRecord> {
  const rows = await db
    .insert(organizations)
    .values({ id: newId(), name: input.name, slug: input.slug })
    .returning();

  return requireRow(rows, 'provisionOrganization');
}

export interface ProvisionUserInput {
  email: string;
  name: string;
  locale?: string;
  /**
   * Platform administration. Deliberately settable only here — no organization role
   * and no tenant-scoped repository can grant it (docs/SECURITY.md §3).
   */
  isPlatformAdmin?: boolean;
}

export async function provisionUser(db: Database, input: ProvisionUserInput): Promise<UserRecord> {
  const rows = await db
    .insert(users)
    .values({
      id: newId(),
      email: input.email,
      name: input.name,
      ...(input.locale === undefined ? {} : { locale: input.locale }),
      ...(input.isPlatformAdmin === undefined ? {} : { isPlatformAdmin: input.isPlatformAdmin }),
    })
    .returning();

  return requireRow(rows, 'provisionUser');
}

export interface ProvisionMembershipInput {
  organizationId: string;
  userId: string;
  role: MembershipRole;
}

/**
 * Creates the first membership of a freshly provisioned organization.
 *
 * `memberships` is tenant-scoped, so this runs inside the organization's own tenant
 * context — provisioning knows the organization it just created.
 */
export async function provisionMembership(
  db: Database,
  input: ProvisionMembershipInput,
): Promise<MembershipRecord> {
  return runWithTenantContext(db, input.organizationId, async (tx) => {
    const rows = await tx
      .insert(memberships)
      .values({
        id: newId(),
        organizationId: input.organizationId,
        userId: input.userId,
        role: input.role,
      })
      .returning();

    return requireRow(rows, 'provisionMembership');
  });
}

export async function findOrganizationBySlug(
  db: Database,
  slug: string,
): Promise<OrganizationRecord | null> {
  const rows = await db.select().from(organizations).where(eq(organizations.slug, slug)).limit(1);
  return rows[0] ?? null;
}
