import { normalizeEmail } from '@organic-os/auth';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database, Transaction } from './client.js';
import { newId } from './ids.js';
import { requireRow } from './repositories/util.js';
import type { JsonObject } from './schema/columns.js';
import { memberships, organizations, users } from './schema/index.js';
import type { ClientAccessMode, MembershipRole } from './schema/enums.js';
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
   * Argon2id encoded hash produced by `@organic-os/auth`. A plaintext password never
   * reaches this module, and the runtime role holds no privilege that could write
   * this column (migration 0003), so setting a credential is a privileged operation
   * by construction — which is exactly the boundary a future sign-up/invitation flow
   * has to cross deliberately (docs/SECURITY.md §2).
   */
  passwordHash?: string;
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
      ...(input.passwordHash === undefined ? {} : { passwordHash: input.passwordHash }),
      ...(input.isPlatformAdmin === undefined ? {} : { isPlatformAdmin: input.isPlatformAdmin }),
    })
    .returning();

  return requireRow(rows, 'provisionUser');
}

export interface ProvisionMembershipInput {
  organizationId: string;
  userId: string;
  role: MembershipRole;
  /**
   * Required, never inferred. Leaving it to a default is exactly the ambiguity
   * migration 0004 removed: an empty client scope must mean zero clients for a
   * `scoped` membership and must never be read as "all" (docs/SECURITY.md §3).
   */
  clientAccessMode: ClientAccessMode;
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
        clientAccessMode: input.clientAccessMode,
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

// ---------------------------------------------------------------------------
// First-organization provisioning (Phase 0.4.2A)
// ---------------------------------------------------------------------------

/**
 * Why provisioning refused.
 *
 * Every one of these is an operator-facing answer on a trusted, non-public command
 * line. None of them is reachable over HTTP: no route calls this module, and the API
 * process never opens a provisioning connection (docs/SECURITY.md §5).
 */
export type ProvisioningFailure =
  /** Name, slug or address did not satisfy the schema. */
  | 'invalid_input'
  /**
   * The slug already belongs to an organization that this command did not create,
   * or created with a different first administrator. Refused rather than joined:
   * silently attaching an administrator to somebody else's tenant is the one
   * mistake a provisioning command must never make.
   */
  | 'organization_slug_taken'
  /** Attaching an existing account was asked for, and no such account exists. */
  | 'user_not_registered'
  /** Creating an account was asked for, and that address already has one. */
  | 'user_already_registered';

export class ProvisioningError extends Error {
  readonly failure: ProvisioningFailure;

  constructor(failure: ProvisioningFailure, detail?: string) {
    super(detail === undefined ? `Provisioning refused: ${failure}` : `${failure}: ${detail}`);
    this.name = 'ProvisioningError';
    this.failure = failure;
  }
}

export function isProvisioningError(value: unknown): value is ProvisioningError {
  return value instanceof ProvisioningError;
}

/**
 * The first administrator of a new organization.
 *
 * Two shapes, because Phase 0 has no invitation flow and therefore no way for a
 * person to set their own first credential:
 *
 *   * `existing_user` — attach an account that already exists. Nothing secret is
 *     involved and this is the preferred path.
 *   * `new_user` — create the account as part of the same transaction. The caller
 *     supplies an **Argon2id encoded hash**, never a plaintext password: hashing
 *     happens in the command that prompted for it, so no plaintext ever reaches this
 *     module, the query log or the database (docs/SECURITY.md §2).
 */
export type FirstAdministratorInput =
  | { readonly kind: 'existing_user'; readonly email: string }
  | {
      readonly kind: 'new_user';
      readonly email: string;
      readonly name: string;
      readonly passwordHash: string;
      readonly locale?: string;
    };

export interface ProvisionFirstOrganizationInput {
  readonly organization: {
    readonly name: string;
    readonly slug: string;
    readonly settings?: JsonObject;
  };
  readonly admin: FirstAdministratorInput;
  /**
   * Client access for the first membership. Defaults to `all_clients`: the first
   * administrator of an organization that has no clients yet must be able to reach
   * the ones they are about to create, and `scoped` with zero rows would leave a
   * tenant nobody can administer (ADR-0016).
   */
  readonly clientAccessMode?: ClientAccessMode;
}

/** Identifiers only. No password, no hash, no connection string, no token. */
export interface ProvisionFirstOrganizationResult {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly userId: string;
  readonly membershipId: string;
  /** False when this call found the organization already provisioned as requested. */
  readonly created: boolean;
}

const provisionInputSchema = z.object({
  name: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(200)),
  // Mirrors the CHECK constraint from migration 0001, so a bad slug is an explained
  // refusal rather than a constraint violation surfacing as an unhandled error.
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  email: z.email().max(320),
});

async function selectUserByEmail(
  tx: Transaction,
  email: string,
): Promise<{ id: string } | undefined> {
  const rows = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);

  return rows[0];
}

/**
 * Resumes an idempotent retry: the slug already exists.
 *
 * Only one situation is a success — the organization is exactly what this command
 * would have created, with this administrator already holding the first
 * `agency_admin` membership. Everything else is `organization_slug_taken`, including
 * "the organization exists but its administrator is someone else", because that is
 * not a retry of this command.
 */
async function resumeExistingOrganization(
  tx: Transaction,
  slug: string,
  email: string,
): Promise<ProvisionFirstOrganizationResult> {
  const existing = (
    await tx.select().from(organizations).where(eq(organizations.slug, slug)).limit(1)
  )[0];

  if (existing === undefined) {
    // The insert conflicted on the slug, so a row exists; not seeing it would mean a
    // concurrent delete. Refuse rather than retry into an unknown state.
    throw new ProvisioningError('organization_slug_taken');
  }

  const user = await selectUserByEmail(tx, email);

  if (user === undefined) {
    throw new ProvisioningError('organization_slug_taken');
  }

  // memberships is tenant-scoped even for the provisioning role (migration 0002), so
  // the context has to be established before the row is visible.
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${existing.id}, true)`);

  const membership = (
    await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.organizationId, existing.id), eq(memberships.userId, user.id)))
      .limit(1)
  )[0];

  if (membership === undefined || membership.role !== 'agency_admin') {
    throw new ProvisioningError('organization_slug_taken');
  }

  return {
    organizationId: existing.id,
    organizationSlug: existing.slug,
    userId: user.id,
    membershipId: membership.id,
    created: false,
  };
}

/**
 * Creates an organization and its first `agency_admin` membership — and, when asked,
 * the administrator's account — as **one transaction**.
 *
 * ## Atomicity
 *
 * Everything happens inside a single `db.transaction`, including the
 * `set_config('app.current_org_id', …, true)` that makes the membership insert legal
 * under Row Level Security. Any failure at any step rolls all of it back, so an
 * organization with no administrator — a tenant nobody can enter and nobody can
 * repair through the application — cannot be committed (§16 of the sub-phase brief).
 *
 * ## Authority
 *
 * This needs a connection using `organic_os_provisioner`. The runtime role holds no
 * INSERT grant on `organizations` or `users` (migration 0002), so passing a runtime
 * handle fails at the database rather than succeeding quietly, and the API process —
 * which opens only the runtime pool — cannot provision at all. There is no HTTP
 * route, no public sign-up and no platform-admin endpoint behind this: the operator
 * command line is the entire surface (§13 of the sub-phase brief).
 *
 * ## Idempotency
 *
 * Keyed on the organization **slug**, which is `UNIQUE` in the schema and is chosen
 * deliberately by the operator — unlike the display name, which may legitimately
 * repeat across tenants. The insert is `ON CONFLICT DO NOTHING`, so a retry after a
 * timeout finds the existing row and returns it with `created: false` instead of
 * creating a second organization. A slug that belongs to a *different* organization
 * than the one this command would have created is refused
 * (`organization_slug_taken`).
 *
 * @throws {ProvisioningError}
 */
export async function provisionFirstOrganization(
  db: Database,
  input: ProvisionFirstOrganizationInput,
): Promise<ProvisionFirstOrganizationResult> {
  const parsed = provisionInputSchema.safeParse({
    name: input.organization.name,
    slug: input.organization.slug,
    email: input.admin.email,
  });

  if (!parsed.success) {
    throw new ProvisioningError(
      'invalid_input',
      parsed.error.issues.map((issue) => issue.path.map(String).join('.') || '(root)').join(', '),
    );
  }

  const email = normalizeEmail(parsed.data.email);
  const clientAccessMode: ClientAccessMode = input.clientAccessMode ?? 'all_clients';
  const settings = input.organization.settings;

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(organizations)
      .values({
        id: newId(),
        name: parsed.data.name,
        slug: parsed.data.slug,
        // The current data model needs no further rows for a new organization:
        // `organizations.settings` defaults to `{}` and `site_settings` is per-site,
        // created with the site it belongs to. There is nothing else to initialise.
        ...(settings === undefined ? {} : { settings }),
      })
      .onConflictDoNothing({ target: organizations.slug })
      .returning();

    const organization = inserted[0];

    if (organization === undefined) {
      return resumeExistingOrganization(tx, parsed.data.slug, email);
    }

    const existingUser = await selectUserByEmail(tx, email);
    let userId: string;

    if (input.admin.kind === 'existing_user') {
      if (existingUser === undefined) {
        // Rolls the organization insert back: no half-provisioned tenant survives.
        throw new ProvisioningError('user_not_registered');
      }

      userId = existingUser.id;
    } else {
      if (existingUser !== undefined) {
        // Refused rather than silently attaching: the operator asked to create an
        // account and set a credential, and quietly ignoring the credential would
        // leave them believing a password they chose is now in effect.
        throw new ProvisioningError('user_already_registered');
      }

      const admin = input.admin;
      const created = await tx
        .insert(users)
        .values({
          id: newId(),
          email,
          name: admin.name,
          passwordHash: admin.passwordHash,
          ...(admin.locale === undefined ? {} : { locale: admin.locale }),
          // Platform administration is never granted by provisioning an organization.
          isPlatformAdmin: false,
        })
        .returning({ id: users.id });

      userId = requireRow(created, 'provisionFirstOrganization.user').id;
    }

    await tx.execute(sql`SELECT set_config('app.current_org_id', ${organization.id}, true)`);

    const membership = await tx
      .insert(memberships)
      .values({
        id: newId(),
        organizationId: organization.id,
        userId,
        role: 'agency_admin',
        clientAccessMode,
      })
      .returning({ id: memberships.id });

    return {
      organizationId: organization.id,
      organizationSlug: organization.slug,
      userId,
      membershipId: requireRow(membership, 'provisionFirstOrganization.membership').id,
      created: true,
    };
  });
}
