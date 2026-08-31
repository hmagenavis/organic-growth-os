import { sql } from 'drizzle-orm';

import type { Database } from './client.js';

/**
 * Database readiness, for the API's readiness probe.
 *
 * A liveness check answers "is this process running"; a readiness check answers "can
 * it serve traffic". They are different questions and a load balancer needs both: a
 * process that is up but cannot reach its database should stop receiving requests
 * without being restarted.
 *
 * The statement is deliberately the cheapest possible round trip. It establishes no
 * tenant context, reads no table, and touches nothing under Row Level Security — a
 * readiness probe must never be a data path.
 *
 * The reason for failure is returned to the caller as a boolean and nothing more. The
 * underlying error is the caller's to log; it must never reach an HTTP response,
 * because connection errors carry hosts, ports and sometimes credentials
 * (docs/SECURITY.md §8).
 */
export async function checkDatabaseReady(db: Database): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}
