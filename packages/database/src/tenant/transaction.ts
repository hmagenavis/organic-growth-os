import { sql } from 'drizzle-orm';

import type { Database, Transaction } from '../client.js';
import { createTenantContext, type TenantContext } from './context.js';

/**
 * Establishes the tenant identity for the current transaction.
 *
 * `set_config(..., true)` is the parameterisable form of `SET LOCAL`: the value is
 * discarded when the transaction ends, so it can never survive a connection being
 * returned to the pool. Session-level `SET` is never used anywhere in this package
 * (docs/SECURITY.md §4, ADR-0002).
 */
async function applyTenantContext(tx: Transaction, organizationId: string): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${organizationId}, true)`);
}

/**
 * Runs `fn` inside a transaction carrying the tenant context.
 *
 * Internal: exposes the raw transaction handle, so it stays inside this package.
 * Application code uses `withTenantTransaction`, which hands out repositories only.
 */
export async function runWithTenantContext<T>(
  db: Database,
  organizationId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await applyTenantContext(tx, organizationId);
    return fn(tx);
  });
}

/**
 * Reads back the tenant identifier PostgreSQL currently sees. Used by tests to prove
 * that context does not survive a transaction.
 */
export async function readCurrentOrganizationId(
  executor: Pick<Database, 'execute'>,
): Promise<string | null> {
  const result = await executor.execute<{ organization_id: string | null }>(
    sql`SELECT app.current_org_id() AS organization_id`,
  );

  return result.rows[0]?.organization_id ?? null;
}

export type { TenantContext };
export { createTenantContext };
