import { Client } from 'pg';

/**
 * One-time cluster bootstrap: extensions and database roles.
 *
 * This is the only step that needs a superuser, and it is deliberately separate from
 * migrations: migrations run as the migration role and may never create roles or
 * escalate privileges.
 *
 * Role model (docs/phases/PHASE-0.2-IMPLEMENTATION.md):
 *   organic_os_migrator     owns the schema; performs DDL.
 *   organic_os_runtime      the API/worker role; no DDL, no BYPASSRLS, no superuser.
 *   organic_os_provisioner  creates organizations and users; no DDL, no BYPASSRLS.
 */

export const ROLE_NAMES = {
  migrator: 'organic_os_migrator',
  runtime: 'organic_os_runtime',
  provisioner: 'organic_os_provisioner',
} as const;

export type RoleKey = keyof typeof ROLE_NAMES;

export interface BootstrapOptions {
  /** Superuser connection to the target database. */
  adminUrl: string;
  passwords: Record<RoleKey, string>;
}

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

function quoteIdentifier(identifier: string): string {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`Refusing to use unsafe SQL identifier: ${identifier}`);
  }

  return `"${identifier}"`;
}

/**
 * Quotes a string literal. With `standard_conforming_strings` on (the default since
 * PostgreSQL 9.1) doubling single quotes is sufficient; control characters are
 * rejected outright rather than escaped.
 */
function quoteLiteral(value: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new Error('Refusing to use a SQL literal containing control characters');
  }

  return `'${value.replace(/'/g, "''")}'`;
}

function assertPasswordUsable(role: string, password: string): void {
  if (password.length < 8) {
    throw new Error(`Password for role ${role} is too short (minimum 8 characters)`);
  }
}

/**
 * Creates extensions and roles idempotently.
 *
 * Passwords are never logged, and the caller supplies them from the environment.
 */
export async function bootstrapDatabase(options: BootstrapOptions): Promise<void> {
  const client = new Client({ connectionString: options.adminUrl });
  await client.connect();

  try {
    // citext backs case-insensitive email and slug columns.
    await client.query('CREATE EXTENSION IF NOT EXISTS citext');

    // pgvector capability is established now so later phases can add vector columns
    // in an ordinary migration. No vector column exists yet.
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch (error: unknown) {
      throw new Error(
        'The pgvector extension is not available on this server. Install pgvector (or use ' +
          'a PostgreSQL image that ships it) — the platform requires vector capability.',
        { cause: error },
      );
    }

    const databaseName = (
      await client.query<{ current_database: string }>('SELECT current_database()')
    ).rows[0]?.current_database;

    if (databaseName === undefined) {
      throw new Error('Could not determine the current database name');
    }

    for (const [key, roleName] of Object.entries(ROLE_NAMES) as [RoleKey, string][]) {
      const password = options.passwords[key];
      assertPasswordUsable(roleName, password);

      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [roleName]);
      const attributes =
        'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT';

      if (exists.rowCount === 0) {
        await client.query(
          `CREATE ROLE ${quoteIdentifier(roleName)} WITH ${attributes} PASSWORD ${quoteLiteral(password)}`,
        );
      } else {
        // Re-assert the attributes on every bootstrap so a role can never drift into
        // holding superuser or BYPASSRLS.
        await client.query(
          `ALTER ROLE ${quoteIdentifier(roleName)} WITH ${attributes} PASSWORD ${quoteLiteral(password)}`,
        );
      }

      await client.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${quoteIdentifier(roleName)}`,
      );
    }

    // Only the migration role may create objects.
    await client.query(
      `GRANT CREATE ON DATABASE ${quoteIdentifier(databaseName)} TO ${quoteIdentifier(ROLE_NAMES.migrator)}`,
    );
    await client.query(
      `GRANT CREATE, USAGE ON SCHEMA public TO ${quoteIdentifier(ROLE_NAMES.migrator)}`,
    );
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  } finally {
    await client.end();
  }
}
