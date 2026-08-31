import { and, asc, eq } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import { newId } from '../ids.js';
import { clients } from '../schema/index.js';
import type { ClientStatus } from '../schema/enums.js';
import type { TenantContext } from '../tenant/context.js';
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

export interface ClientRepository {
  create(input: CreateClientInput): Promise<ClientRecord>;
  list(): Promise<ClientRecord[]>;
  findById(id: string): Promise<ClientRecord | null>;
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

    async findById(id: string): Promise<ClientRecord | null> {
      const rows = await tx
        .select()
        .from(clients)
        .where(and(eq(clients.id, id), scoped))
        .limit(1);

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
