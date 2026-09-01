import { Pool } from 'pg';

import { describeConnection } from '../config.js';
import { loadMigrationFiles } from '../migrations/runner.js';
import { tlsOptionsFor } from '../tls.js';

/**
 * Environment verification for a managed (Supabase) staging database.
 *
 * ## What this is, and what it is deliberately not
 *
 * The disposable Testcontainers suite in CI is the clean-room verifier: it proves the
 * *logic* — tenant isolation, authorization, membership administration, session
 * revocation, audit integrity — against a database built from migration 0001 every
 * time (docs/TESTING.md §2). Nothing here replaces it, and staging must never become
 * the place those properties are checked, because staging accumulates state and a
 * green run there could reflect data rather than code.
 *
 * This verifies the *environment*: that the managed platform actually gave us the
 * privileges, extensions, policies and transaction semantics the architecture
 * assumes. Those are exactly the things a managed provider can quietly differ on, and
 * exactly the things a disposable container cannot tell us about.
 *
 * ## Non-destructive by construction
 *
 * Every check is either a catalog read or runs inside a transaction that is rolled
 * back. The checks that assert a *denial* (runtime cannot provision, audit rows
 * cannot be rewritten, runtime cannot perform DDL) each open their own transaction,
 * because a failed statement aborts the one it ran in. Nothing here commits, and
 * nothing here seeds or deletes rows.
 *
 * ## Refuses to run against the wrong database
 *
 * The caller must state the host it believes it is verifying. If the connection
 * string points somewhere else, this throws before opening a connection. That is the
 * whole protection against pointing a verification run at production by accident.
 */

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface StagingCheck {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  /** Safe to log: never contains a credential, a connection string or row data. */
  readonly detail: string;
}

export interface StagingVerificationInput {
  /** The application (RLS-constrained) connection. Required. */
  readonly runtimeUrl: string;
  /** Enables migration-state checks. Optional: the runtime role cannot read them. */
  readonly migratorUrl?: string | undefined;
  /** Enables provisioner attribute checks from the provisioner's own connection. */
  readonly provisionerUrl?: string | undefined;
  /**
   * The host the operator believes they are verifying. Compared against every
   * supplied connection string before anything is opened.
   */
  readonly expectedHost: string;
}

export interface StagingVerificationResult {
  readonly host: string;
  readonly checks: readonly StagingCheck[];
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

export class StagingTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StagingTargetError';
  }
}

/** Tenant tables that must be under RLS *and* FORCE RLS (migration 0002). */
const TENANT_TABLES = [
  'organizations',
  'users',
  'memberships',
  'membership_client_scopes',
  'clients',
  'sites',
  'site_settings',
  'integrations',
  'integration_tokens',
  'audit_logs',
] as const;

/** Table privileges the runtime role must hold, and no more (migrations 0002/0003). */
const EXPECTED_RUNTIME_TABLE_GRANTS: Readonly<Record<string, readonly string[]>> = {
  organizations: ['SELECT', 'UPDATE'],
  users: ['SELECT'],
  audit_logs: ['INSERT', 'SELECT'],
};

const ROLE_NAMES_TO_CHECK = [
  'organic_os_runtime',
  'organic_os_migrator',
  'organic_os_provisioner',
] as const;

function pass(id: string, title: string, detail: string): StagingCheck {
  return { id, title, status: 'pass', detail };
}

function fail(id: string, title: string, detail: string): StagingCheck {
  return { id, title, status: 'fail', detail };
}

function skipped(id: string, title: string, detail: string): StagingCheck {
  return { id, title, status: 'skipped', detail };
}

function hostOf(url: string): string {
  return describeConnection(url).host;
}

/**
 * Refuses any connection string that does not point at the host the operator named.
 *
 * Deliberately compared on the host alone: a Supabase project's runtime, migration
 * and pooler URLs differ in role, port and pooling mode but share a host per class,
 * and the mistake worth preventing is "wrong project", not "wrong port".
 */
function assertTarget(url: string, expectedHost: string, label: string): void {
  const host = hostOf(url);

  if (host !== expectedHost) {
    throw new StagingTargetError(
      `Refusing to verify: the ${label} connection points at ${host}, but ${expectedHost} was ` +
        'named as the target. Verification never runs against a database the operator did not ' +
        'explicitly identify.',
    );
  }
}

/** Runs `sql` in a transaction and always rolls back. Returns the first row. */
async function inRolledBackTransaction<T extends Record<string, unknown>>(
  pool: Pool,
  statements: readonly string[],
  read: string,
  values: readonly unknown[] = [],
): Promise<T | undefined> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const statement of statements) {
      await client.query(statement, [...values]);
    }

    const result = await client.query<T>(read, [...values]);
    return result.rows[0];
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
}

/**
 * Asserts that `sql` is refused. Each call gets its own transaction, because a failed
 * statement poisons the transaction it ran in.
 *
 * @returns the PostgreSQL error message, or null when the statement unexpectedly
 * succeeded.
 */
async function expectDenied(pool: Pool, sql: string): Promise<string | null> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(sql);
    return null;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : 'refused';
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The transaction was already aborted by the failing statement.
    }

    client.release();
  }
}

/**
 * `server_version_num` rather than `server_version`, for two reasons found the first
 * time this ran against a real server. `SHOW server_version` returns its value in a
 * column named `server_version`, not `version` — reading the wrong column produced
 * `undefined`, and a NaN comparison reported PostgreSQL 17.6 as failing "16 or newer".
 * And `server_version` is a display string: `Number.parseInt` on a distribution's
 * `16.4 (Ubuntu 16.4-1.pgdg22.04+1)` happens to work, but only by luck of the leading
 * digits. `server_version_num` is the integer the server computes for exactly this
 * comparison (170006 = 17.6), so nothing is parsed out of prose.
 */
async function checkServerVersion(pool: Pool): Promise<StagingCheck> {
  const id = 'postgres.version';
  const title = 'PostgreSQL 16 or newer';
  const result = await pool.query<{ display: string; numeric: string }>(
    `SELECT current_setting('server_version') AS display,
            current_setting('server_version_num') AS numeric`,
  );

  const display = result.rows[0]?.display ?? '(unknown)';
  const numeric = Number.parseInt(result.rows[0]?.numeric ?? '', 10);

  return Number.isFinite(numeric) && numeric >= 160_000
    ? pass(id, title, `server_version ${display} (${String(numeric)})`)
    : fail(id, title, `server_version ${display}; the schema targets 16+ (ADR-0002)`);
}

async function checkExtensions(pool: Pool): Promise<StagingCheck[]> {
  const result = await pool.query<{ extname: string; nspname: string }>(
    `SELECT e.extname, n.nspname
       FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname IN ('vector', 'citext')`,
  );

  const installed = new Map(result.rows.map((row) => [row.extname, row.nspname]));

  return (['citext', 'vector'] as const).map((name) => {
    const id = `extension.${name}`;
    const title = `${name} extension installed`;
    const schema = installed.get(name);

    return schema === undefined
      ? fail(id, title, `${name} is not installed in this database`)
      : pass(id, title, `installed in schema "${schema}"`);
  });
}

/**
 * The extension schema has to be reachable from the runtime role's `search_path`.
 *
 * On a managed platform extensions often live in a dedicated schema rather than in
 * `public`, and a role we created ourselves does not inherit the platform role's
 * `search_path`. If `citext` cannot be resolved, every query touching `users.email`
 * or `organizations.slug` fails — so this is checked directly rather than inferred
 * from the extension being present.
 */
async function checkTypeResolution(pool: Pool): Promise<StagingCheck> {
  const id = 'types.resolvable';
  const title = 'citext resolves on the runtime search_path';

  try {
    await pool.query("SELECT 'a'::citext = 'A'::citext AS equal");
    return pass(id, title, 'citext is resolvable without schema qualification');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return fail(
      id,
      title,
      `citext is not on the runtime role's search_path (${message}). Fix with an ` +
        'administrative ALTER ROLE ... SET search_path, never by editing a migration.',
    );
  }
}

async function checkRoleAttributes(pool: Pool): Promise<StagingCheck[]> {
  const result = await pool.query<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
  }>(
    `SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
       FROM pg_roles WHERE rolname = ANY($1)`,
    [[...ROLE_NAMES_TO_CHECK]],
  );

  const byName = new Map(result.rows.map((row) => [row.rolname, row]));

  return ROLE_NAMES_TO_CHECK.map((roleName) => {
    const id = `role.${roleName}.attributes`;
    const title = `${roleName} holds no dangerous attribute`;
    const row = byName.get(roleName);

    if (row === undefined) {
      return fail(id, title, `role ${roleName} does not exist in this database`);
    }

    const violations = [
      row.rolsuper ? 'SUPERUSER' : null,
      row.rolbypassrls ? 'BYPASSRLS' : null,
      row.rolcreatedb ? 'CREATEDB' : null,
      row.rolcreaterole ? 'CREATEROLE' : null,
    ].filter((value): value is string => value !== null);

    return violations.length === 0
      ? pass(id, title, 'NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE')
      : fail(id, title, `holds ${violations.join(', ')}`);
  });
}

async function checkForceRls(pool: Pool): Promise<StagingCheck> {
  const id = 'rls.force';
  const title = 'FORCE ROW LEVEL SECURITY on every tenant table';

  const result = await pool.query<{
    relname: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(
    `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`,
    [[...TENANT_TABLES]],
  );

  const byName = new Map(result.rows.map((row) => [row.relname, row]));
  const problems: string[] = [];

  for (const table of TENANT_TABLES) {
    const row = byName.get(table);

    if (row === undefined) {
      problems.push(`${table}: missing`);
    } else if (!row.relrowsecurity) {
      problems.push(`${table}: RLS disabled`);
    } else if (!row.relforcerowsecurity) {
      problems.push(`${table}: FORCE RLS disabled`);
    }
  }

  return problems.length === 0
    ? pass(id, title, `${String(TENANT_TABLES.length)} tables enabled and forced`)
    : fail(id, title, problems.join('; '));
}

async function checkRuntimeGrants(pool: Pool): Promise<StagingCheck[]> {
  const result = await pool.query<{ table_name: string; privilege_type: string }>(
    `SELECT table_name, privilege_type
       FROM information_schema.role_table_grants
      WHERE grantee = 'organic_os_runtime' AND table_name = ANY($1)`,
    [Object.keys(EXPECTED_RUNTIME_TABLE_GRANTS)],
  );

  const held = new Map<string, string[]>();

  for (const row of result.rows) {
    const existing = held.get(row.table_name);

    if (existing === undefined) {
      held.set(row.table_name, [row.privilege_type]);
    } else {
      existing.push(row.privilege_type);
    }
  }

  return Object.entries(EXPECTED_RUNTIME_TABLE_GRANTS).map(([table, expected]) => {
    const id = `grants.runtime.${table}`;
    const title = `runtime holds exactly ${expected.join(' + ')} on ${table}`;
    const actual = (held.get(table) ?? []).sort();

    return actual.join(',') === [...expected].sort().join(',')
      ? pass(id, title, actual.join(', ') || '(none)')
      : fail(id, title, `holds ${actual.join(', ') || '(none)'}, expected ${expected.join(', ')}`);
  });
}

async function checkNoSecurityDefiner(pool: Pool): Promise<StagingCheck> {
  const id = 'functions.no_security_definer';
  const title = 'no SECURITY DEFINER function in schema app';

  const result = await pool.query<{ proname: string }>(
    `SELECT p.proname
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.prosecdef`,
  );

  return result.rows.length === 0
    ? pass(id, title, 'none')
    : fail(id, title, `found: ${result.rows.map((row) => row.proname).join(', ')}`);
}

/**
 * The property the whole tenancy model rests on: `set_config(..., true)` is scoped to
 * its transaction and cannot survive the connection returning to the pool.
 *
 * Run against the connection string the application will actually use, because the
 * answer depends on the pooling mode in front of the database — a transaction-mode
 * pooler pins a server connection for the duration of a transaction, and this is the
 * check that proves it rather than assuming it.
 */
async function checkTransactionLocalContext(pool: Pool): Promise<StagingCheck[]> {
  const checks: StagingCheck[] = [];
  const organizationId = '018f9e1a-0000-7000-8000-0000000000ff';

  const inside = await inRolledBackTransaction<{ organization_id: string | null }>(
    pool,
    [`SELECT set_config('app.current_org_id', '${organizationId}', true)`],
    'SELECT app.current_org_id()::text AS organization_id',
  );

  checks.push(
    inside?.organization_id === organizationId
      ? pass(
          'tenant.context.visible',
          'tenant context is visible inside its transaction',
          'set_config(..., true) then app.current_org_id() agree',
        )
      : fail(
          'tenant.context.visible',
          'tenant context is visible inside its transaction',
          `app.current_org_id() returned ${String(inside?.organization_id)}`,
        ),
  );

  // Committed rather than rolled back, then re-read: a pooler that leaked session
  // state would surface it here, on whichever backend the next statement lands on.
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_org_id', '${organizationId}', true)`);
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  const residues: string[] = [];

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const after = await pool.query<{ organization_id: string | null }>(
      'SELECT app.current_org_id()::text AS organization_id',
    );

    const residue = after.rows[0]?.organization_id;

    if (residue !== null && residue !== undefined) {
      residues.push(residue);
    }
  }

  checks.push(
    residues.length === 0
      ? pass(
          'tenant.context.pool_safety',
          'tenant context does not survive its transaction',
          '20 post-commit reads across pooled checkouts all returned NULL',
        )
      : fail(
          'tenant.context.pool_safety',
          'tenant context does not survive its transaction',
          `${String(residues.length)} of 20 post-commit reads still carried a tenant context — ` +
            'this connection mode is NOT safe for transaction-local tenancy',
        ),
  );

  return checks;
}

/** Unnamed parameterised statements must work: transaction-mode poolers reject named ones. */
async function checkParameterisedQueries(pool: Pool): Promise<StagingCheck> {
  const id = 'protocol.parameterised';
  const title = 'parameterised queries work through this connection mode';

  try {
    const result = await pool.query<{ value: string }>('SELECT $1::text AS value', ['probe']);

    return result.rows[0]?.value === 'probe'
      ? pass(id, title, 'extended protocol without named prepared statements')
      : fail(id, title, 'parameter did not round-trip');
  } catch (error: unknown) {
    return fail(id, title, error instanceof Error ? error.message : 'unknown error');
  }
}

/** With a tenant context set to an organization that owns nothing, every table reads empty. */
async function checkTenantIsolationProbe(pool: Pool): Promise<StagingCheck> {
  const id = 'rls.cross_tenant_probe';
  const title = 'an unrelated tenant context reads zero rows everywhere';
  const foreignOrganization = '00000000-0000-4000-8000-0000000000aa';

  const row = await inRolledBackTransaction<{ total: string }>(
    pool,
    [`SELECT set_config('app.current_org_id', '${foreignOrganization}', true)`],
    `SELECT (
       (SELECT count(*) FROM clients) +
       (SELECT count(*) FROM sites) +
       (SELECT count(*) FROM site_settings) +
       (SELECT count(*) FROM memberships) +
       (SELECT count(*) FROM audit_logs) +
       (SELECT count(*) FROM membership_client_scopes)
     )::text AS total`,
  );

  return row?.total === '0'
    ? pass(id, title, 'clients, sites, site_settings, memberships, scopes, audit_logs all empty')
    : fail(id, title, `policies admitted ${String(row?.total)} rows for a foreign organization`);
}

/** Authentication context must not unlock tenant data (migration 0003 vs 0002/0004). */
async function checkAuthenticationGrantsNoTenancy(pool: Pool): Promise<StagingCheck> {
  const id = 'authn.grants_no_tenancy';
  const title = 'an authentication context establishes no tenant access';
  const someUser = '00000000-0000-4000-8000-0000000000bb';

  const row = await inRolledBackTransaction<{ organization_id: string | null; clients: string }>(
    pool,
    [
      `SELECT set_config('app.auth_user_id', '${someUser}', true)`,
      `SELECT set_config('app.authz_user_id', '${someUser}', true)`,
    ],
    `SELECT app.current_org_id()::text AS organization_id,
            (SELECT count(*) FROM clients)::text AS clients`,
  );

  return row?.organization_id === null && row.clients === '0'
    ? pass(id, title, 'no tenant context, and zero tenant rows readable')
    : fail(
        id,
        title,
        `current_org_id=${String(row?.organization_id)} clients=${String(row?.clients)}`,
      );
}

async function checkRuntimeDenials(pool: Pool): Promise<StagingCheck[]> {
  const denials: readonly { id: string; title: string; sql: string }[] = [
    {
      id: 'runtime.cannot_provision',
      title: 'runtime cannot create an organization',
      sql: "INSERT INTO organizations (id, name, slug) VALUES (gen_random_uuid(), 'probe', 'probe-should-fail')",
    },
    {
      id: 'runtime.cannot_create_user',
      title: 'runtime cannot create a user',
      sql: "INSERT INTO users (id, email, name) VALUES (gen_random_uuid(), 'probe@example.test', 'probe')",
    },
    {
      id: 'audit.no_update',
      title: 'runtime cannot rewrite an audit record',
      sql: "UPDATE audit_logs SET action = 'tampered'",
    },
    {
      id: 'audit.no_delete',
      title: 'runtime cannot delete an audit record',
      sql: 'DELETE FROM audit_logs',
    },
    {
      id: 'runtime.cannot_ddl',
      title: 'runtime cannot perform DDL',
      sql: 'CREATE TABLE staging_verification_probe (id uuid)',
    },
    {
      id: 'runtime.cannot_disable_rls',
      title: 'runtime cannot disable row level security',
      sql: 'ALTER TABLE clients DISABLE ROW LEVEL SECURITY',
    },
  ];

  const results: StagingCheck[] = [];

  for (const denial of denials) {
    const message = await expectDenied(pool, denial.sql);

    results.push(
      message === null
        ? fail(denial.id, denial.title, 'the statement SUCCEEDED — this is a privilege escalation')
        : pass(denial.id, denial.title, 'refused by the database'),
    );
  }

  return results;
}

async function checkMigrationState(migratorUrl: string): Promise<StagingCheck[]> {
  const pool = new Pool({
    connectionString: migratorUrl,
    max: 1,
    ssl: tlsOptionsFor(migratorUrl),
  });

  try {
    const files = await loadMigrationFiles();
    const applied = await pool.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );

    const byVersion = new Map(applied.rows.map((row) => [row.version, row.checksum]));
    const missing: string[] = [];
    const drifted: string[] = [];

    for (const file of files) {
      const checksum = byVersion.get(file.version);

      if (checksum === undefined) {
        missing.push(file.version);
      } else if (checksum !== file.checksum) {
        drifted.push(file.version);
      }
    }

    const checks: StagingCheck[] = [
      missing.length === 0
        ? pass(
            'migrations.applied',
            'every migration in the repository is applied',
            `${String(files.length)} applied`,
          )
        : fail(
            'migrations.applied',
            'every migration in the repository is applied',
            `pending: ${missing.join(', ')}`,
          ),
      drifted.length === 0
        ? pass(
            'migrations.checksums',
            'applied migration checksums match the repository',
            'no drift',
          )
        : fail(
            'migrations.checksums',
            'applied migration checksums match the repository',
            `checksum drift in: ${drifted.join(', ')}`,
          ),
    ];

    return checks;
  } finally {
    await pool.end();
  }
}

/**
 * Runs every environment check.
 *
 * @throws {StagingTargetError} when a connection string does not point at
 * `expectedHost` — before any connection is opened.
 */
export async function verifyStagingEnvironment(
  input: StagingVerificationInput,
): Promise<StagingVerificationResult> {
  assertTarget(input.runtimeUrl, input.expectedHost, 'runtime');

  if (input.migratorUrl !== undefined) {
    assertTarget(input.migratorUrl, input.expectedHost, 'migration');
  }

  if (input.provisionerUrl !== undefined) {
    assertTarget(input.provisionerUrl, input.expectedHost, 'provisioner');
  }

  // max: 1 so consecutive statements provably reuse one client-side slot, which is
  // what makes the residue probe meaningful rather than incidental.
  const runtime = new Pool({
    connectionString: input.runtimeUrl,
    max: 1,
    ssl: tlsOptionsFor(input.runtimeUrl),
  });
  const checks: StagingCheck[] = [];

  try {
    checks.push(await checkServerVersion(runtime));
    checks.push(...(await checkExtensions(runtime)));
    checks.push(await checkTypeResolution(runtime));
    checks.push(...(await checkRoleAttributes(runtime)));
    checks.push(await checkForceRls(runtime));
    checks.push(...(await checkRuntimeGrants(runtime)));
    checks.push(await checkNoSecurityDefiner(runtime));
    checks.push(await checkParameterisedQueries(runtime));
    checks.push(...(await checkTransactionLocalContext(runtime)));
    checks.push(await checkTenantIsolationProbe(runtime));
    checks.push(await checkAuthenticationGrantsNoTenancy(runtime));
    checks.push(...(await checkRuntimeDenials(runtime)));
  } finally {
    await runtime.end();
  }

  if (input.migratorUrl === undefined) {
    checks.push(
      skipped(
        'migrations.applied',
        'every migration in the repository is applied',
        'no migration connection supplied',
      ),
    );
  } else {
    checks.push(...(await checkMigrationState(input.migratorUrl)));
  }

  return {
    host: input.expectedHost,
    checks,
    passed: checks.filter((check) => check.status === 'pass').length,
    failed: checks.filter((check) => check.status === 'fail').length,
    skipped: checks.filter((check) => check.status === 'skipped').length,
  };
}
