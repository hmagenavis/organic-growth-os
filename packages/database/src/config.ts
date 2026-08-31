import { z } from 'zod';

/**
 * Database configuration.
 *
 * Kept in this package rather than `@organic-os/config` because these variables are
 * meaningful only where a database connection is opened, and several of them
 * (superuser and role passwords) are used exclusively by the one-off bootstrap CLI.
 * Applications that never talk to the database must not be forced to define them.
 *
 * No value here is ever logged: connection strings carry credentials, so use
 * `describeConnection()` when reporting what a process connected to.
 */

const connectionString = z.string().min(1);

/** Runtime (application) connection — the RLS-constrained role. */
export const runtimeDatabaseEnvSchema = z.object({
  DATABASE_URL: connectionString,
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(200).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
  DATABASE_IDLE_TX_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(15_000),
});
export type RuntimeDatabaseEnv = z.infer<typeof runtimeDatabaseEnvSchema>;

/** Migration connection — owns the schema, used only by the migration CLI. */
export const migratorDatabaseEnvSchema = z.object({
  DATABASE_MIGRATOR_URL: connectionString,
});

/** Provisioning connection — creates organizations and users. No DDL rights. */
export const provisionerDatabaseEnvSchema = z.object({
  DATABASE_PROVISIONER_URL: connectionString,
});

/** Superuser connection — bootstrap only (roles + extensions), never used at runtime. */
export const bootstrapDatabaseEnvSchema = z.object({
  DATABASE_ADMIN_URL: connectionString,
  DATABASE_MIGRATOR_PASSWORD: z.string().min(1),
  DATABASE_RUNTIME_PASSWORD: z.string().min(1),
  DATABASE_PROVISIONER_PASSWORD: z.string().min(1),
});
export type BootstrapDatabaseEnv = z.infer<typeof bootstrapDatabaseEnvSchema>;

export class DatabaseConfigError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`Invalid database configuration: ${missing.join(', ')}`);
    this.name = 'DatabaseConfigError';
    this.missing = missing;
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Parses an environment source against a schema, reporting only variable names —
 * never values, because every one of them may contain a credential.
 */
export function parseDatabaseEnv<T extends z.ZodType>(
  schema: T,
  source: EnvSource = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);

  if (!result.success) {
    throw new DatabaseConfigError(
      result.error.issues.map((issue) => issue.path.map(String).join('.') || '(root)'),
    );
  }

  return result.data;
}

/** Credential-free description of a connection target, safe to log. */
export function describeConnection(url: string): { host: string; port: string; database: string } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parsed.port === '' ? '5432' : parsed.port,
      database: parsed.pathname.replace(/^\//, ''),
    };
  } catch {
    return { host: '(unparsable)', port: '(unknown)', database: '(unknown)' };
  }
}

/** True when the connection targets the developer's own machine. */
export function isLocalConnection(url: string): boolean {
  const { host } = describeConnection(url);
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
