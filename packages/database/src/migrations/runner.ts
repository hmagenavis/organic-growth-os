import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool, PoolClient } from 'pg';

/**
 * Forward-only migration runner.
 *
 * Migrations are hand-written SQL committed to source control, applied in filename
 * order, each in its own transaction, and recorded with a checksum. There is no
 * schema generation, no drift-based diffing and no automatic execution: migrations
 * run only from the CLI, never from a web request (ADR-0003).
 */

export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** Serialises concurrent migrators; released when the session ends. */
const ADVISORY_LOCK_KEY = 4_924_100_115;

const MIGRATION_FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrationStatusEntry {
  version: string;
  name: string;
  state: 'applied' | 'pending';
  appliedAt: Date | null;
}

export interface MigrateResult {
  applied: MigrationFile[];
  skipped: string[];
}

export class MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

/** Checksums are computed on newline-normalised content so Windows checkouts match CI. */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export async function loadMigrationFiles(
  directory: string = MIGRATIONS_DIRECTORY,
): Promise<MigrationFile[]> {
  const entries = await readdir(directory);
  const files: MigrationFile[] = [];

  for (const filename of entries.filter((entry) => entry.endsWith('.sql')).sort()) {
    const matched = MIGRATION_FILENAME_PATTERN.exec(filename);

    if (matched === null) {
      throw new MigrationError(
        `Migration filename must look like 0001_description.sql, found: ${filename}`,
      );
    }

    const [, version, name] = matched;

    if (version === undefined || name === undefined) {
      throw new MigrationError(`Could not parse migration filename: ${filename}`);
    }

    const sql = await readFile(join(directory, filename), 'utf8');

    if (files.some((file) => file.version === version)) {
      throw new MigrationError(`Duplicate migration version ${version}`);
    }

    files.push({ version, name, filename, sql, checksum: checksumOf(sql) });
  }

  return files;
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      execution_ms integer NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function fetchApplied(client: PoolClient): Promise<AppliedMigration[]> {
  const result = await client.query<{
    version: string;
    name: string;
    checksum: string;
    applied_at: Date;
  }>('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version');

  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

/**
 * Fails loudly when history and disk disagree: an edited migration or a deleted file
 * means the database is not the schema this code expects.
 */
function verifyHistory(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): void {
  for (const record of applied) {
    const file = files.find((candidate) => candidate.version === record.version);

    if (file === undefined) {
      throw new MigrationError(
        `Migration ${record.version} (${record.name}) is recorded as applied but its file is missing. ` +
          'Applied migrations are immutable; restore the file instead of deleting it.',
      );
    }

    if (file.checksum !== record.checksum) {
      throw new MigrationError(
        `Migration ${record.version} (${record.name}) was modified after being applied. ` +
          'Applied migrations are immutable; add a new forward migration instead.',
      );
    }
  }
}

export async function migrate(pool: Pool): Promise<MigrateResult> {
  const files = await loadMigrationFiles();
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await ensureMigrationsTable(client);

    const applied = await fetchApplied(client);
    verifyHistory(files, applied);

    const appliedVersions = new Set(applied.map((record) => record.version));
    const result: MigrateResult = { applied: [], skipped: [...appliedVersions] };

    for (const file of files) {
      if (appliedVersions.has(file.version)) {
        continue;
      }

      const startedAt = process.hrtime.bigint();

      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        const executionMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);

        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES ($1, $2, $3, $4)',
          [file.version, file.name, file.checksum, executionMs],
        );
        await client.query('COMMIT');
      } catch (error: unknown) {
        await client.query('ROLLBACK');
        throw new MigrationError(`Migration ${file.filename} failed and was rolled back`, {
          cause: error,
        });
      }

      result.applied.push(file);
    }

    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    client.release();
  }
}

export async function migrationStatus(pool: Pool): Promise<MigrationStatusEntry[]> {
  const files = await loadMigrationFiles();
  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await fetchApplied(client);
    verifyHistory(files, applied);

    return files.map((file) => {
      const record = applied.find((candidate) => candidate.version === file.version);

      return {
        version: file.version,
        name: file.name,
        state: record === undefined ? 'pending' : 'applied',
        appliedAt: record?.appliedAt ?? null,
      };
    });
  } finally {
    client.release();
  }
}
