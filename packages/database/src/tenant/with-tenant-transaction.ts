import type { Database } from '../client.js';
import { createTenantRepositories, type TenantRepositories } from '../repositories/index.js';
import { createTenantContext, type TenantContext } from './context.js';
import { runWithTenantContext } from './transaction.js';

/**
 * Runs `fn` against tenant-scoped repositories inside a single transaction whose
 * tenant identity is established transaction-locally.
 *
 * This is the only supported entry point to tenant data:
 *
 *   1. the context is re-validated here, so a malformed or missing organization id
 *      fails before a connection is used;
 *   2. `app.current_org_id` is set with `set_config(..., true)`, so it is discarded
 *      when the transaction ends and can never leak to the next user of a pooled
 *      connection;
 *   3. the callback receives repositories, never a raw SQL handle, so tenant scope
 *      cannot be bypassed from application code.
 *
 * @throws {InvalidTenantContextError} when the tenant context is absent or invalid.
 */
export async function withTenantTransaction<T>(
  db: Database,
  tenant: TenantContext,
  fn: (repositories: TenantRepositories) => Promise<T>,
): Promise<T> {
  const validated = createTenantContext(tenant);

  return runWithTenantContext(db, validated.organizationId, async (tx) =>
    fn(createTenantRepositories(tx, validated)),
  );
}
