import { and, asc, eq } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import { newId } from '../ids.js';
import { memberships } from '../schema/index.js';
import type { MembershipRole } from '../schema/enums.js';
import type { TenantContext } from '../tenant/context.js';
import { requireRow } from './util.js';

export type MembershipRecord = typeof memberships.$inferSelect;

export interface CreateMembershipInput {
  userId: string;
  role: MembershipRole;
}

export interface MembershipRepository {
  create(input: CreateMembershipInput): Promise<MembershipRecord>;
  list(): Promise<MembershipRecord[]>;
  findById(id: string): Promise<MembershipRecord | null>;
  findByUserId(userId: string): Promise<MembershipRecord | null>;
  updateRole(id: string, role: MembershipRole): Promise<MembershipRecord | null>;
  delete(id: string): Promise<boolean>;
}

/**
 * Organization memberships.
 *
 * `MembershipRole` contains organization roles only, so platform administration can
 * never be granted here — it lives on `users.is_platform_admin`, which this
 * repository cannot write (the runtime role has no UPDATE grant on `users`).
 */
export function createMembershipRepository(
  tx: Transaction,
  tenant: TenantContext,
): MembershipRepository {
  const scoped = eq(memberships.organizationId, tenant.organizationId);

  return {
    async create(input: CreateMembershipInput): Promise<MembershipRecord> {
      const rows = await tx
        .insert(memberships)
        .values({
          id: newId(),
          organizationId: tenant.organizationId,
          userId: input.userId,
          role: input.role,
        })
        .returning();

      return requireRow(rows, 'memberships.create');
    },

    async list(): Promise<MembershipRecord[]> {
      return tx.select().from(memberships).where(scoped).orderBy(asc(memberships.createdAt));
    },

    async findById(id: string): Promise<MembershipRecord | null> {
      const rows = await tx
        .select()
        .from(memberships)
        .where(and(eq(memberships.id, id), scoped))
        .limit(1);

      return rows[0] ?? null;
    },

    async findByUserId(userId: string): Promise<MembershipRecord | null> {
      const rows = await tx
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, userId), scoped))
        .limit(1);

      return rows[0] ?? null;
    },

    async updateRole(id: string, role: MembershipRole): Promise<MembershipRecord | null> {
      const rows = await tx
        .update(memberships)
        .set({ role })
        .where(and(eq(memberships.id, id), scoped))
        .returning();

      return rows[0] ?? null;
    },

    async delete(id: string): Promise<boolean> {
      const rows = await tx
        .delete(memberships)
        .where(and(eq(memberships.id, id), scoped))
        .returning({ id: memberships.id });

      return rows.length > 0;
    },
  };
}
