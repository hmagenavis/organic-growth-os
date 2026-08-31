import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { checksumOf, loadMigrationFiles, MigrationError } from './runner.js';

describe('checksumOf', () => {
  it('is stable for identical content', () => {
    expect(checksumOf('SELECT 1;')).toBe(checksumOf('SELECT 1;'));
  });

  it('ignores line-ending differences so Windows and CI agree', () => {
    expect(checksumOf('CREATE TABLE a();\r\nCREATE TABLE b();')).toBe(
      checksumOf('CREATE TABLE a();\nCREATE TABLE b();'),
    );
  });

  it('changes when the statement changes', () => {
    expect(checksumOf('SELECT 1;')).not.toBe(checksumOf('SELECT 2;'));
  });
});

describe('loadMigrationFiles', () => {
  it('loads the committed migrations in deterministic order', async () => {
    const files = await loadMigrationFiles();

    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files.map((file) => file.version)).toEqual(
      [...files.map((file) => file.version)].sort(),
    );
    expect(files[0]?.version).toBe('0001');
    expect(files.every((file) => file.checksum.length === 64)).toBe(true);
    expect(files.every((file) => file.sql.length > 0)).toBe(true);
  });

  it('rejects a filename that does not carry an ordered version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'organic-os-migrations-'));
    await writeFile(join(directory, 'add_table.sql'), 'SELECT 1;', 'utf8');

    await expect(loadMigrationFiles(directory)).rejects.toBeInstanceOf(MigrationError);
  });

  it('accepts a well-formed directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'organic-os-migrations-'));
    await writeFile(join(directory, '0001_initial.sql'), 'SELECT 1;', 'utf8');
    await writeFile(join(directory, '0002_second_change.sql'), 'SELECT 2;', 'utf8');

    const files = await loadMigrationFiles(directory);

    expect(files.map((file) => file.name)).toEqual(['initial', 'second_change']);
  });
});
