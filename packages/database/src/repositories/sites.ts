import { and, asc, eq } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import { newId } from '../ids.js';
import { sites } from '../schema/index.js';
import type { SiteStatus } from '../schema/enums.js';
import type { JsonObject } from '../schema/columns.js';
import type { TenantContext } from '../tenant/context.js';
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

export interface SiteRepository {
  create(input: CreateSiteInput): Promise<SiteRecord>;
  list(): Promise<SiteRecord[]>;
  listByClient(clientId: string): Promise<SiteRecord[]>;
  findById(id: string): Promise<SiteRecord | null>;
  update(id: string, patch: UpdateSiteInput): Promise<SiteRecord | null>;
  delete(id: string): Promise<boolean>;
}

export function createSiteRepository(tx: Transaction, tenant: TenantContext): SiteRepository {
  const scoped = eq(sites.organizationId, tenant.organizationId);

  return {
    async create(input: CreateSiteInput): Promise<SiteRecord> {
      // A client from another organization is rejected by the composite foreign key
      // (client_id, organization_id) even before Row Level Security is consulted.
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

    async findById(id: string): Promise<SiteRecord | null> {
      const rows = await tx
        .select()
        .from(sites)
        .where(and(eq(sites.id, id), scoped))
        .limit(1);

      return rows[0] ?? null;
    },

    async update(id: string, patch: UpdateSiteInput): Promise<SiteRecord | null> {
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

      if (Object.keys(values).length === 0) {
        return this.findById(id);
      }

      const rows = await tx
        .update(sites)
        .set(values)
        .where(and(eq(sites.id, id), scoped))
        .returning();

      return rows[0] ?? null;
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
