import { and, asc, eq, sql } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import { newId } from '../ids.js';
import { clients, membershipClientScopes } from '../schema/index.js';
import type { ClientStatus } from '../schema/enums.js';
import type { TenantContext } from '../tenant/context.js';
import { clampPageLimit, decodeKeysetCursor, encodeKeysetCursor } from './keyset.js';
import { requireRow } from './util.js';

export type ClientRecord = typeof clients.$inferSelect;

/** Note the absence of `organizationId`: it comes from the tenant context only. */
export interface CreateClientInput {
  name: string;
  status?: ClientStatus;
  industry?: string | null;
  notes?: string | null;
}

export interface UpdateClientInput {
  name?: string;
  status?: ClientStatus;
  industry?: string | null;
  notes?: string | null;
}

/**
 * Which clients of the organization a listing may return.
 *
 * A discriminated union, and the `scoped` branch carries the membership rather than a
 * pre-computed id list, so the intersection is computed by PostgreSQL against
 * `membership_client_scopes` instead of in JavaScript over rows that were fetched
 * first. There is no third shape and no default: a caller must state the mode, so
 * "no scope rows" can never be reached by a code path that meant "everything"
 * (ADR-0016).
 */
export type ClientListAccess =
  { readonly mode: 'all_clients' } | { readonly mode: 'scoped'; readonly membershipId: string };

export interface ClientPageRequest {
  /** Row count to return. Bounded by the API contract, re-clamped here defensively. */
  readonly limit: number;
  /** Opaque cursor from a previous page, or absent for the first page. */
  readonly cursor?: string | undefined;
}

export interface ClientPage {
  readonly clients: readonly ClientRecord[];
  /** `null` when this was the last page. */
  readonly nextCursor: string | null;
}

/** The cursor did not decode to a position this ordering can resume from. */
export class InvalidClientCursorError extends Error {
  constructor() {
    super('Invalid client page cursor');
    this.name = 'InvalidClientCursorError';
  }
}

export function isInvalidClientCursorError(value: unknown): value is InvalidClientCursorError {
  return value instanceof InvalidClientCursorError;
}

/** Hard ceiling independent of the HTTP contract, so no caller can ask for the table. */
const MAX_PAGE_LIMIT = 100;

export interface ClientRepository {
  create(input: CreateClientInput): Promise<ClientRecord>;
  list(): Promise<ClientRecord[]>;

  /**
   * One page of the clients a membership is authorized to see.
   *
   * The client-access decision is part of the query rather than a filter applied to
   * its result: an `all_clients` listing reads the organization's clients, and a
   * `scoped` listing inner-joins `membership_client_scopes`, so a membership with no
   * scope rows gets an empty page from PostgreSQL rather than from a JavaScript
   * predicate somebody could forget to write. Row Level Security constrains both
   * tables underneath regardless.
   *
   * Ordering is `(created_at, id)` ascending — total, because `id` is unique — and
   * the keyset predicate uses the same pair, so pages cannot overlap or skip.
   *
   * @throws {InvalidClientCursorError} when `cursor` is not a position from this
   * ordering.
   */
  listAuthorizedPage(access: ClientListAccess, page: ClientPageRequest): Promise<ClientPage>;

  findById(id: string): Promise<ClientRecord | null>;
  /** Locks one client of this organization for the rest of the transaction. */
  lockById(id: string): Promise<ClientRecord | null>;
  update(id: string, patch: UpdateClientInput): Promise<ClientRecord | null>;
  delete(id: string): Promise<boolean>;
}

export function createClientRepository(tx: Transaction, tenant: TenantContext): ClientRepository {
  // Repeated in every query as the first isolation layer; Row Level Security enforces
  // the same predicate independently in the database.
  const scoped = eq(clients.organizationId, tenant.organizationId);

  return {
    async create(input: CreateClientInput): Promise<ClientRecord> {
      const rows = await tx
        .insert(clients)
        .values({
          id: newId(),
          organizationId: tenant.organizationId,
          name: input.name,
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.industry === undefined ? {} : { industry: input.industry }),
          ...(input.notes === undefined ? {} : { notes: input.notes }),
        })
        .returning();

      return requireRow(rows, 'clients.create');
    },

    async list(): Promise<ClientRecord[]> {
      return tx.select().from(clients).where(scoped).orderBy(asc(clients.createdAt));
    },

    async listAuthorizedPage(
      access: ClientListAccess,
      page: ClientPageRequest,
    ): Promise<ClientPage> {
      const limit = clampPageLimit(page.limit, MAX_PAGE_LIMIT);
      const position =
        page.cursor === undefined
          ? null
          : decodeKeysetCursor(page.cursor, () => new InvalidClientCursorError());

      // Row-value comparison: exactly `(created_at, id) > (cursor)`, which is the
      // ordering itself rather than a hand-expanded approximation of it.
      const after =
        position === null
          ? undefined
          : sql`(${clients.createdAt}, ${clients.id}) > (${position.createdAt}::timestamptz, ${position.id}::uuid)`;

      // `created_at` as PostgreSQL renders it, kept alongside the row purely to build
      // the next cursor at full precision.
      const projection = {
        client: clients,
        cursorCreatedAt: sql<string>`${clients.createdAt}::text`.as('cursor_created_at'),
      };

      // One extra row answers "is there another page?" without a second query and
      // without a count.
      const fetchLimit = limit + 1;

      const rows =
        access.mode === 'all_clients'
          ? await tx
              .select(projection)
              .from(clients)
              .where(and(scoped, after))
              .orderBy(asc(clients.createdAt), asc(clients.id))
              .limit(fetchLimit)
          : await tx
              .select(projection)
              .from(clients)
              .innerJoin(
                membershipClientScopes,
                and(
                  eq(membershipClientScopes.clientId, clients.id),
                  eq(membershipClientScopes.membershipId, access.membershipId),
                  eq(membershipClientScopes.organizationId, tenant.organizationId),
                ),
              )
              .where(and(scoped, after))
              .orderBy(asc(clients.createdAt), asc(clients.id))
              .limit(fetchLimit);

      const hasMore = rows.length > limit;
      const visible = hasMore ? rows.slice(0, limit) : rows;
      const last = visible.at(-1);

      return {
        clients: visible.map((row) => row.client),
        nextCursor:
          hasMore && last !== undefined
            ? encodeKeysetCursor({ createdAt: last.cursorCreatedAt, id: last.client.id })
            : null,
      };
    },

    async findById(id: string): Promise<ClientRecord | null> {
      const rows = await tx
        .select()
        .from(clients)
        .where(and(eq(clients.id, id), scoped))
        .limit(1);

      return rows[0] ?? null;
    },

    async lockById(id: string): Promise<ClientRecord | null> {
      const rows = await tx
        .select()
        .from(clients)
        .where(and(eq(clients.id, id), scoped))
        .limit(1)
        .for('update');

      return rows[0] ?? null;
    },

    async update(id: string, patch: UpdateClientInput): Promise<ClientRecord | null> {
      const values: Partial<typeof clients.$inferInsert> = {};

      if (patch.name !== undefined) {
        values.name = patch.name;
      }
      if (patch.status !== undefined) {
        values.status = patch.status;
      }
      if (patch.industry !== undefined) {
        values.industry = patch.industry;
      }
      if (patch.notes !== undefined) {
        values.notes = patch.notes;
      }

      if (Object.keys(values).length === 0) {
        return this.findById(id);
      }

      const rows = await tx
        .update(clients)
        .set(values)
        .where(and(eq(clients.id, id), scoped))
        .returning();

      return rows[0] ?? null;
    },

    async delete(id: string): Promise<boolean> {
      const rows = await tx
        .delete(clients)
        .where(and(eq(clients.id, id), scoped))
        .returning({ id: clients.id });

      return rows.length > 0;
    },
  };
}
