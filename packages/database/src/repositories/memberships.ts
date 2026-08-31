import { and, asc, eq, or } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import { newId } from '../ids.js';
import { memberships, users } from '../schema/index.js';
import type { ClientAccessMode, MembershipRole } from '../schema/enums.js';
import type { TenantContext } from '../tenant/context.js';
import { requireRow } from './util.js';

export type MembershipRecord = typeof memberships.$inferSelect;

export interface CreateMembershipInput {
  userId: string;
  role: MembershipRole;
  /** Required, never inferred (migration 0004). */
  clientAccessMode: ClientAccessMode;
}

/**
 * A membership together with the identity behind it.
 *
 * The user projection is written out field by field rather than spread: `users` also
 * carries `password_hash` and `is_platform_admin`, and neither may reach an
 * administration response (docs/SECURITY.md §3). A `select(users)` that later grew a
 * column would leak it silently; this cannot.
 */
export interface MembershipWithUser {
  readonly membership: MembershipRecord;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
  };
}

export interface MembershipRepository {
  create(input: CreateMembershipInput): Promise<MembershipRecord>;
  list(): Promise<MembershipRecord[]>;
  findById(id: string): Promise<MembershipRecord | null>;
  findByUserId(userId: string): Promise<MembershipRecord | null>;
  updateRole(id: string, role: MembershipRole): Promise<MembershipRecord | null>;
  updateClientAccessMode(id: string, mode: ClientAccessMode): Promise<MembershipRecord | null>;
  delete(id: string): Promise<boolean>;

  /** Every membership of the organization with its user's directory fields. */
  listWithUsers(): Promise<MembershipWithUser[]>;
  findWithUserById(id: string): Promise<MembershipWithUser | null>;

  /**
   * Locks the rows a membership mutation must reason about, for the rest of the
   * transaction.
   *
   * The set is: every `agency_admin` membership of the organization, plus the target
   * — the target because it is being written, the admins because the invariant "this
   * organization always has at least one agency admin" is a statement about all of
   * them at once. Reading the admins without locking them is the classic
   * check-then-act race: two transactions each see two admins and each demotes one.
   *
   * `ORDER BY id` is not cosmetic. Every caller locks the same rows in the same
   * order, so two concurrent administrators queue behind one another instead of
   * deadlocking. Under READ COMMITTED the predicate is re-evaluated against the
   * committed row version once the lock is granted, so the second transaction sees
   * the first one's effect rather than the snapshot it started with.
   */
  lockForAdministration(targetMembershipId: string): Promise<MembershipRecord[]>;

  /** Locks one membership of this organization for the rest of the transaction. */
  lockById(id: string): Promise<MembershipRecord | null>;
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
          clientAccessMode: input.clientAccessMode,
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

    async updateClientAccessMode(
      id: string,
      clientAccessMode: ClientAccessMode,
    ): Promise<MembershipRecord | null> {
      const rows = await tx
        .update(memberships)
        .set({ clientAccessMode })
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

    async listWithUsers(): Promise<MembershipWithUser[]> {
      // The join is what makes the `users` read legal: the policy from migration 0002
      // admits a user row only while that user holds a membership in the current
      // organization, which is exactly the join predicate.
      return tx
        .select({
          membership: memberships,
          user: { id: users.id, email: users.email, name: users.name },
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(scoped)
        .orderBy(asc(memberships.createdAt), asc(memberships.id));
    },

    async findWithUserById(id: string): Promise<MembershipWithUser | null> {
      const rows = await tx
        .select({
          membership: memberships,
          user: { id: users.id, email: users.email, name: users.name },
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.id, id), scoped))
        .limit(1);

      return rows[0] ?? null;
    },

    async lockForAdministration(targetMembershipId: string): Promise<MembershipRecord[]> {
      return tx
        .select()
        .from(memberships)
        .where(
          and(
            scoped,
            or(eq(memberships.role, 'agency_admin'), eq(memberships.id, targetMembershipId)),
          ),
        )
        .orderBy(asc(memberships.id))
        .for('update');
    },

    async lockById(id: string): Promise<MembershipRecord | null> {
      const rows = await tx
        .select()
        .from(memberships)
        .where(and(eq(memberships.id, id), scoped))
        .limit(1)
        .for('update');

      return rows[0] ?? null;
    },
  };
}
