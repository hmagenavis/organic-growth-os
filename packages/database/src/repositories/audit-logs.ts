import { desc, eq } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import { newId } from '../ids.js';
import { auditLogs } from '../schema/index.js';
import type { AuditResult, AuditSource } from '../schema/enums.js';
import type { JsonObject } from '../schema/columns.js';
import type { TenantContext } from '../tenant/context.js';
import { requireRow } from './util.js';

export type AuditLogRecord = typeof auditLogs.$inferSelect;

export interface AppendAuditLogInput {
  action: string;
  targetType: string;
  targetId?: string | null;
  before?: JsonObject | null;
  after?: JsonObject | null;
  source: AuditSource;
  result: AuditResult;
  ip?: string | null;
}

/**
 * Append-only audit trail.
 *
 * There is intentionally no update or delete method, and the runtime database role
 * holds only SELECT and INSERT on this table, so history cannot be rewritten even by
 * code that bypasses this repository (migration 0002).
 *
 * The actor is taken from the tenant context rather than from arguments, so an entry
 * cannot be attributed to someone else.
 */
export interface AuditLogRepository {
  append(input: AppendAuditLogInput): Promise<AuditLogRecord>;
  list(limit?: number): Promise<AuditLogRecord[]>;
}

function actorFields(tenant: TenantContext): {
  actorKind: 'user' | 'system' | 'worker';
  actorId: string | null;
  actorMembershipId: string | null;
} {
  switch (tenant.actor.kind) {
    case 'user':
      return {
        actorKind: 'user',
        actorId: tenant.actor.userId,
        // From the context, never from `input`: an entry cannot be attributed to a
        // membership the caller was not acting through.
        actorMembershipId: tenant.actor.membershipId ?? null,
      };
    case 'worker':
      return {
        actorKind: 'worker',
        actorId: `worker:${tenant.actor.queue}`,
        actorMembershipId: null,
      };
    case 'system':
      return { actorKind: 'system', actorId: null, actorMembershipId: null };
  }
}

export function createAuditLogRepository(
  tx: Transaction,
  tenant: TenantContext,
): AuditLogRepository {
  const scoped = eq(auditLogs.organizationId, tenant.organizationId);

  return {
    async append(input: AppendAuditLogInput): Promise<AuditLogRecord> {
      const actor = actorFields(tenant);

      const rows = await tx
        .insert(auditLogs)
        .values({
          id: newId(),
          organizationId: tenant.organizationId,
          actorKind: actor.actorKind,
          actorId: actor.actorId,
          actorMembershipId: actor.actorMembershipId,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId ?? null,
          before: input.before ?? null,
          after: input.after ?? null,
          source: input.source,
          result: input.result,
          ip: input.ip ?? null,
        })
        .returning();

      return requireRow(rows, 'auditLogs.append');
    },

    async list(limit = 100): Promise<AuditLogRecord[]> {
      return tx
        .select()
        .from(auditLogs)
        .where(scoped)
        .orderBy(desc(auditLogs.createdAt))
        .limit(Math.min(Math.max(limit, 1), 1000));
    },
  };
}
