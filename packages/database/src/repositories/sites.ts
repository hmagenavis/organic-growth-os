import { and, asc, eq, sql } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import { newId } from '../ids.js';
import { sites, siteSettings } from '../schema/index.js';
import type { AutopilotMode, SiteStatus } from '../schema/enums.js';
import type { JsonObject } from '../schema/columns.js';
import type { TenantContext } from '../tenant/context.js';
import { clampPageLimit, decodeKeysetCursor, encodeKeysetCursor } from './keyset.js';
import { requireRow } from './util.js';

export type SiteRecord = typeof sites.$inferSelect;

export interface CreateSiteInput {
  clientId: string;
  baseUrl: string;
  status?: SiteStatus;
  timezone?: string;
  language?: string;
  crawlBudget?: JsonObject;
}

export interface UpdateSiteInput {
  baseUrl?: string;
  status?: SiteStatus;
  timezone?: string;
  language?: string;
  crawlBudget?: JsonObject;
}

/**
 * A site together with the autopilot mode of its settings row.
 *
 * `autopilotMode` is `null` only when no `site_settings` row exists. Every site
 * created through `SiteService` gets one in the same transaction, so `null` means the
 * row was written by something that bypassed that service — it is reported honestly
 * rather than defaulted to `review`, because inventing an execution-safety value would
 * be a claim about policy that nothing in the database supports.
 */
export interface SiteWithSettings {
  readonly site: SiteRecord;
  readonly autopilotMode: AutopilotMode | null;
}

export interface SitePageRequest {
  /** Row count to return. Bounded by the API contract, re-clamped here defensively. */
  readonly limit: number;
  /** Opaque cursor from a previous page, or absent for the first page. */
  readonly cursor?: string | undefined;
}

export interface SitePage {
  readonly sites: readonly SiteWithSettings[];
  /** `null` when this was the last page. */
  readonly nextCursor: string | null;
}

/** The cursor did not decode to a position this ordering can resume from. */
export class InvalidSiteCursorError extends Error {
  constructor() {
    super('Invalid site page cursor');
    this.name = 'InvalidSiteCursorError';
  }
}

export function isInvalidSiteCursorError(value: unknown): value is InvalidSiteCursorError {
  return value instanceof InvalidSiteCursorError;
}

/**
 * `sites` already carries `UNIQUE (organization_id, base_url)` (migration 0001), and
 * that constraint — not a preflight `SELECT` — is the concurrency authority: two
 * simultaneous creates of the same URL cannot both pass a check-then-insert, but they
 * can never both satisfy a unique index.
 *
 * The scope of the constraint is the **organization**, not the client, so this can
 * also be raised for a site under a client the caller cannot reach. That is a real,
 * accepted disclosure and it is bounded: the response says only that this
 * organization already uses the URL, never which client or site holds it, and only a
 * caller who is already an `agency_admin` of the organization can provoke it.
 */
export class SiteBaseUrlConflictError extends Error {
  constructor() {
    super('A site with this base URL already exists in this organization');
    this.name = 'SiteBaseUrlConflictError';
  }
}

export function isSiteBaseUrlConflictError(value: unknown): value is SiteBaseUrlConflictError {
  return value instanceof SiteBaseUrlConflictError;
}

/** Hard ceiling independent of the HTTP contract, so no caller can ask for the table. */
const MAX_PAGE_LIMIT = 100;

/** The name PostgreSQL gives the inline `UNIQUE (organization_id, base_url)`. */
const BASE_URL_CONSTRAINT = 'sites_organization_id_base_url_key';
const UNIQUE_VIOLATION = '23505';

/**
 * Whether an error is the unique violation of one named constraint.
 *
 * The driver's error is looked for through the `cause` chain because a query error may
 * arrive wrapped. Only the named constraint is translated: any other unique violation
 * is a bug rather than a caller conflict, and must keep surfacing as one.
 */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };

    if (candidate.code === UNIQUE_VIOLATION && candidate.constraint === constraint) {
      return true;
    }

    current = candidate.cause;
  }

  return false;
}

async function translatingBaseUrlConflict<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    if (isUniqueViolation(error, BASE_URL_CONSTRAINT)) {
      throw new SiteBaseUrlConflictError();
    }

    throw error;
  }
}

export interface SiteRepository {
  /**
   * @throws {SiteBaseUrlConflictError} when the organization already uses this URL.
   */
  create(input: CreateSiteInput): Promise<SiteRecord>;
  list(): Promise<SiteRecord[]>;
  listByClient(clientId: string): Promise<SiteRecord[]>;

  /**
   * One page of the sites belonging to one client of this organization.
   *
   * There is no site-level access mode: a site is reachable exactly when its parent
   * client is, and the caller has already proven that through
   * `session.requireClient`. `clientId` must therefore come from an
   * `AuthorizedClientContext`, never from a route parameter — the predicate here is
   * ownership, not authorization.
   *
   * Ordering is `(created_at, id)` ascending — total, because `id` is unique — and
   * the keyset predicate uses the same pair, so pages cannot overlap or skip. The
   * settings row is left-joined (`site_settings.site_id` is `UNIQUE`, so the join is
   * one-to-one) which keeps the autopilot mode one query per page rather than one per
   * row.
   *
   * @throws {InvalidSiteCursorError} when `cursor` is not a position from this
   * ordering.
   */
  listAuthorizedPage(clientId: string, page: SitePageRequest): Promise<SitePage>;

  findById(id: string): Promise<SiteRecord | null>;
  /** One site, proven to belong to both this organization and this client. */
  findByIdForClient(clientId: string, id: string): Promise<SiteWithSettings | null>;
  /** Locks one site of this organization and client for the rest of the transaction. */
  lockByIdForClient(clientId: string, id: string): Promise<SiteRecord | null>;
  update(id: string, patch: UpdateSiteInput): Promise<SiteRecord | null>;
  /**
   * Updates a site that must still belong to `clientId`.
   *
   * @throws {SiteBaseUrlConflictError} when the organization already uses this URL.
   */
  updateForClient(clientId: string, id: string, patch: UpdateSiteInput): Promise<SiteRecord | null>;
  delete(id: string): Promise<boolean>;
}

export function createSiteRepository(tx: Transaction, tenant: TenantContext): SiteRepository {
  const scoped = eq(sites.organizationId, tenant.organizationId);

  function patchValues(patch: UpdateSiteInput): Partial<typeof sites.$inferInsert> {
    const values: Partial<typeof sites.$inferInsert> = {};

    if (patch.baseUrl !== undefined) {
      values.baseUrl = patch.baseUrl;
    }
    if (patch.status !== undefined) {
      values.status = patch.status;
    }
    if (patch.timezone !== undefined) {
      values.timezone = patch.timezone;
    }
    if (patch.language !== undefined) {
      values.language = patch.language;
    }
    if (patch.crawlBudget !== undefined) {
      values.crawlBudget = patch.crawlBudget;
    }

    return values;
  }

  return {
    async create(input: CreateSiteInput): Promise<SiteRecord> {
      // A client from another organization is rejected by the composite foreign key
      // (client_id, organization_id) even before Row Level Security is consulted.
      return translatingBaseUrlConflict(async () => {
        const rows = await tx
          .insert(sites)
          .values({
            id: newId(),
            organizationId: tenant.organizationId,
            clientId: input.clientId,
            baseUrl: input.baseUrl,
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
            ...(input.language === undefined ? {} : { language: input.language }),
            ...(input.crawlBudget === undefined ? {} : { crawlBudget: input.crawlBudget }),
          })
          .returning();

        return requireRow(rows, 'sites.create');
      });
    },

    async list(): Promise<SiteRecord[]> {
      return tx.select().from(sites).where(scoped).orderBy(asc(sites.createdAt));
    },

    async listByClient(clientId: string): Promise<SiteRecord[]> {
      return tx
        .select()
        .from(sites)
        .where(and(eq(sites.clientId, clientId), scoped))
        .orderBy(asc(sites.createdAt));
    },

    async listAuthorizedPage(clientId: string, page: SitePageRequest): Promise<SitePage> {
      const limit = clampPageLimit(page.limit, MAX_PAGE_LIMIT);
      const position =
        page.cursor === undefined
          ? null
          : decodeKeysetCursor(page.cursor, () => new InvalidSiteCursorError());

      // Row-value comparison: exactly `(created_at, id) > (cursor)`, which is the
      // ordering itself rather than a hand-expanded approximation of it.
      const after =
        position === null
          ? undefined
          : sql`(${sites.createdAt}, ${sites.id}) > (${position.createdAt}::timestamptz, ${position.id}::uuid)`;

      // One extra row answers "is there another page?" without a second query and
      // without a count.
      const rows = await tx
        .select({
          site: sites,
          // Explicitly nullable: this is the outer side of a left join, and Drizzle
          // does not widen a hand-written projection the way it widens a table one.
          autopilotMode: sql<AutopilotMode | null>`${siteSettings.autopilotMode}`.as(
            'autopilot_mode',
          ),
          cursorCreatedAt: sql<string>`${sites.createdAt}::text`.as('cursor_created_at'),
        })
        .from(sites)
        .leftJoin(
          siteSettings,
          and(
            eq(siteSettings.siteId, sites.id),
            eq(siteSettings.organizationId, tenant.organizationId),
          ),
        )
        .where(and(eq(sites.clientId, clientId), scoped, after))
        .orderBy(asc(sites.createdAt), asc(sites.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const visible = hasMore ? rows.slice(0, limit) : rows;
      const last = visible.at(-1);

      return {
        sites: visible.map((row) => ({ site: row.site, autopilotMode: row.autopilotMode })),
        nextCursor:
          hasMore && last !== undefined
            ? encodeKeysetCursor({ createdAt: last.cursorCreatedAt, id: last.site.id })
            : null,
      };
    },

    async findById(id: string): Promise<SiteRecord | null> {
      const rows = await tx
        .select()
        .from(sites)
        .where(and(eq(sites.id, id), scoped))
        .limit(1);

      return rows[0] ?? null;
    },

    async findByIdForClient(clientId: string, id: string): Promise<SiteWithSettings | null> {
      const rows = await tx
        .select({
          site: sites,
          autopilotMode: sql<AutopilotMode | null>`${siteSettings.autopilotMode}`.as(
            'autopilot_mode',
          ),
        })
        .from(sites)
        .leftJoin(
          siteSettings,
          and(
            eq(siteSettings.siteId, sites.id),
            eq(siteSettings.organizationId, tenant.organizationId),
          ),
        )
        .where(and(eq(sites.id, id), eq(sites.clientId, clientId), scoped))
        .limit(1);

      const row = rows[0];

      return row === undefined ? null : { site: row.site, autopilotMode: row.autopilotMode };
    },

    async lockByIdForClient(clientId: string, id: string): Promise<SiteRecord | null> {
      // No join: `FOR UPDATE` cannot be applied to the nullable side of an outer join,
      // and the settings row is not what this lock is protecting.
      const rows = await tx
        .select()
        .from(sites)
        .where(and(eq(sites.id, id), eq(sites.clientId, clientId), scoped))
        .limit(1)
        .for('update');

      return rows[0] ?? null;
    },

    async update(id: string, patch: UpdateSiteInput): Promise<SiteRecord | null> {
      const values = patchValues(patch);

      if (Object.keys(values).length === 0) {
        return this.findById(id);
      }

      return translatingBaseUrlConflict(async () => {
        const rows = await tx
          .update(sites)
          .set(values)
          .where(and(eq(sites.id, id), scoped))
          .returning();

        return rows[0] ?? null;
      });
    },

    async updateForClient(
      clientId: string,
      id: string,
      patch: UpdateSiteInput,
    ): Promise<SiteRecord | null> {
      const values = patchValues(patch);

      if (Object.keys(values).length === 0) {
        const existing = await this.findByIdForClient(clientId, id);
        return existing === null ? null : existing.site;
      }

      // The parent client is part of the predicate as well as of the caller's proof,
      // so a site that moved clients between the authorization check and this write
      // updates nothing rather than the wrong row.
      return translatingBaseUrlConflict(async () => {
        const rows = await tx
          .update(sites)
          .set(values)
          .where(and(eq(sites.id, id), eq(sites.clientId, clientId), scoped))
          .returning();

        return rows[0] ?? null;
      });
    },

    async delete(id: string): Promise<boolean> {
      const rows = await tx
        .delete(sites)
        .where(and(eq(sites.id, id), scoped))
        .returning({ id: sites.id });

      return rows.length > 0;
    },
  };
}
