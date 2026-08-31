import { eq } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import { organizations } from '../schema/index.js';
import type { TenantContext } from '../tenant/context.js';
import type { JsonObject } from '../schema/columns.js';

export type OrganizationRecord = typeof organizations.$inferSelect;

export interface UpdateOrganizationInput {
  name?: string;
  settings?: JsonObject;
}

/**
 * The current organization only.
 *
 * There is deliberately no `create` or `delete`: provisioning a tenant is privileged
 * and the runtime role holds no INSERT or DELETE grant on this table
 * (migration 0002).
 */
export interface OrganizationRepository {
  getCurrent(): Promise<OrganizationRecord | null>;
  update(patch: UpdateOrganizationInput): Promise<OrganizationRecord | null>;
}

export function createOrganizationRepository(
  tx: Transaction,
  tenant: TenantContext,
): OrganizationRepository {
  return {
    async getCurrent(): Promise<OrganizationRecord | null> {
      const rows = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, tenant.organizationId))
        .limit(1);

      return rows[0] ?? null;
    },

    async update(patch: UpdateOrganizationInput): Promise<OrganizationRecord | null> {
      const values: Partial<typeof organizations.$inferInsert> = {};

      if (patch.name !== undefined) {
        values.name = patch.name;
      }
      if (patch.settings !== undefined) {
        values.settings = patch.settings;
      }

      if (Object.keys(values).length === 0) {
        return this.getCurrent();
      }

      const rows = await tx
        .update(organizations)
        .set(values)
        .where(eq(organizations.id, tenant.organizationId))
        .returning();

      return rows[0] ?? null;
    },
  };
}
