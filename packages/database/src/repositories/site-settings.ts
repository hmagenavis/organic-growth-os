import { and, eq } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import { newId } from '../ids.js';
import { siteSettings } from '../schema/index.js';
import type { AutopilotMode } from '../schema/enums.js';
import type { TenantContext } from '../tenant/context.js';
import type {
  GraduationPolicyInput,
  IngestionOverridesInput,
  RetentionOverridesInput,
} from '../settings/schemas.js';
import {
  parseGraduationPolicy,
  parseIngestionOverrides,
  parseRetentionOverrides,
} from '../settings/schemas.js';
import { requireRow } from './util.js';

export type SiteSettingsRecord = typeof siteSettings.$inferSelect;

export interface UpdateSiteSettingsInput {
  autopilotMode?: AutopilotMode;
  graduationPolicy?: GraduationPolicyInput;
  ingestionOverrides?: IngestionOverridesInput;
  retentionOverrides?: RetentionOverridesInput;
}

export interface SiteSettingsRepository {
  /** Creates the settings row for a site, defaulting autopilot mode to REVIEW. */
  createForSite(siteId: string): Promise<SiteSettingsRecord>;
  findBySiteId(siteId: string): Promise<SiteSettingsRecord | null>;
  update(siteId: string, patch: UpdateSiteSettingsInput): Promise<SiteSettingsRecord | null>;
}

export function createSiteSettingsRepository(
  tx: Transaction,
  tenant: TenantContext,
): SiteSettingsRepository {
  const scoped = eq(siteSettings.organizationId, tenant.organizationId);

  return {
    async createForSite(siteId: string): Promise<SiteSettingsRecord> {
      const rows = await tx
        .insert(siteSettings)
        .values({
          id: newId(),
          organizationId: tenant.organizationId,
          siteId,
        })
        .returning();

      return requireRow(rows, 'siteSettings.createForSite');
    },

    async findBySiteId(siteId: string): Promise<SiteSettingsRecord | null> {
      const rows = await tx
        .select()
        .from(siteSettings)
        .where(and(eq(siteSettings.siteId, siteId), scoped))
        .limit(1);

      return rows[0] ?? null;
    },

    async update(
      siteId: string,
      patch: UpdateSiteSettingsInput,
    ): Promise<SiteSettingsRecord | null> {
      const values: Partial<typeof siteSettings.$inferInsert> = {};

      // Autopilot mode is written as given; graduating a site to SAFE_AUTOPILOT is an
      // authorization decision made above this layer (docs/EXECUTION-SAFETY.md §3.1).
      if (patch.autopilotMode !== undefined) {
        values.autopilotMode = patch.autopilotMode;
      }
      // Structured settings are validated before storage so malformed policy can
      // never be persisted as opaque JSON.
      if (patch.graduationPolicy !== undefined) {
        values.graduationPolicy = parseGraduationPolicy(patch.graduationPolicy);
      }
      if (patch.ingestionOverrides !== undefined) {
        values.ingestionOverrides = parseIngestionOverrides(patch.ingestionOverrides);
      }
      if (patch.retentionOverrides !== undefined) {
        values.retentionOverrides = parseRetentionOverrides(patch.retentionOverrides);
      }

      if (Object.keys(values).length === 0) {
        return this.findBySiteId(siteId);
      }

      const rows = await tx
        .update(siteSettings)
        .set(values)
        .where(and(eq(siteSettings.siteId, siteId), scoped))
        .returning();

      return rows[0] ?? null;
    },
  };
}
