import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { tlsOptionsFor } from './tls.js';

export type Database = NodePgDatabase<Record<string, never>>;

/** Transaction-bound handle. Every tenant-scoped operation runs on one of these. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: Pool;
  close(): Promise<void>;
}

export interface CreateDatabaseOptions {
  connectionString: string;
  maxConnections?: number;
  statementTimeoutMs?: number;
  idleTransactionTimeoutMs?: number;
  applicationName?: string;
}

/**
 * Opens a connection pool.
 *
 * Statement and idle-in-transaction timeouts are passed as connection options rather
 * than issued as `SET` statements after connecting: session-level state on a pooled
 * connection is exactly the pattern tenant context must never use, so this package
 * does not establish any session state at all (docs/SECURITY.md §4).
 */
export function createDatabase(options: CreateDatabaseOptions): DatabaseHandle {
  const {
    connectionString,
    maxConnections = 10,
    statementTimeoutMs = 30_000,
    idleTransactionTimeoutMs = 15_000,
    applicationName = 'organic-os',
  } = options;

  const pool = new Pool({
    connectionString,
    ssl: tlsOptionsFor(connectionString),
    max: maxConnections,
    application_name: applicationName,
    options: [
      `-c statement_timeout=${String(statementTimeoutMs)}`,
      `-c idle_in_transaction_session_timeout=${String(idleTransactionTimeoutMs)}`,
    ].join(' '),
  });

  const db = drizzle(pool);

  return {
    db,
    pool,
    close: async (): Promise<void> => {
      await pool.end();
    },
  };
}
