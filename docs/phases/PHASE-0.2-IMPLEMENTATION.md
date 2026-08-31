# PHASE-0.2 — Database Foundation, Migrations & Tenant Isolation (implementation record)

Status: **COMPLETE** — 2026-08-31
Scope source: `docs/phases/PHASE-0.md` §0.2
Verified against PostgreSQL 16 via Testcontainers: 34 integration tests, including the
full tenant-isolation suite. See §9.

---

## 1. What was implemented

`packages/database` — the complete persistence layer:

| Area | Contents |
|---|---|
| Schema | 12 tables across identity, tenancy, platform and integration shells |
| Migrations | Hand-written SQL, forward-only, checksummed, advisory-locked runner |
| Roles | Three separated roles created by a superuser-only bootstrap step |
| RLS | Enabled **and forced** on every organization-scoped table |
| Tenant context | Transaction-local only (`set_config(..., true)`), validated per call |
| Repositories | Seven tenant-scoped repositories; no unscoped query path is exported |
| Settings | Typed Zod schemas for the JSONB policy columns |
| Testing | Testcontainers global setup, two-tenant seed, isolation + migration suites |

## 2. Schema created

`organizations`, `users`, `memberships`, `membership_client_scopes`, `sessions`,
`clients`, `sites`, `site_settings`, `feature_flags`, `audit_logs`, `integrations`,
`integration_tokens` — plus the runner-owned `schema_migrations`.

Nothing from a later domain (crawl, SEO, content, execution, AI visibility) exists.

**Cross-organization integrity is structural, not conventional.** `memberships`,
`clients` and `sites` each carry a `UNIQUE (id, organization_id)`, and children
reference them through composite foreign keys:

```
membership_client_scopes (membership_id, organization_id) → memberships (id, organization_id)
membership_client_scopes (client_id,     organization_id) → clients     (id, organization_id)
sites                    (client_id,     organization_id) → clients     (id, organization_id)
site_settings            (site_id,       organization_id) → sites       (id, organization_id)
integrations             (client_id,     organization_id) → clients     (id, organization_id)
integrations             (site_id,       organization_id) → sites       (id, organization_id)
integration_tokens       (integration_id, organization_id) → integrations (id, organization_id)
```

A membership in organization A therefore cannot be scoped to a client of organization
B: the row would have to claim both organizations at once. Optional parents use
`MATCH SIMPLE`, so a NULL `client_id`/`site_id` skips the check and a set value is
always same-organization.

`audit_logs.organization_id` deliberately carries **no** foreign key — audit records
must outlive the tenant they describe (DATA-MODEL.md §12).

## 3. Migrations

| File | Contents |
|---|---|
| `0001_foundation.sql` | `app` schema, `app.current_org_id()`, `app.set_updated_at()`, enums, all 12 tables, constraints, indexes, updated-at triggers |
| `0002_rls_and_grants.sql` | RLS enable/force, policies, and least-privilege grants |

Runner properties: filename order (`NNNN_name.sql`), one transaction per migration,
`pg_advisory_lock` against concurrent runners, SHA-256 checksums recorded in
`schema_migrations`, newline normalisation so Windows and CI agree, and **loud
failure** if an applied migration was edited or its file deleted. Migrations run only
from the CLI — nothing in `apps/*` imports the runner, so a web request can never
trigger one.

```bash
pnpm db:bootstrap   # once per database: extensions + roles (superuser)
pnpm db:migrate     # apply pending migrations (migration role)
pnpm db:status      # exit code 2 when migrations are pending
pnpm db:reset       # LOCAL ONLY — drop, recreate, bootstrap, migrate
```

`db:reset` refuses to run when `NODE_ENV=production` or when either connection is not
loopback, and there is no flag that lifts those guards.

## 4. Database roles and grants

Created by `bootstrap`, which is the only step needing a superuser. Every role is
`NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION`, re-asserted on each
bootstrap so a role cannot drift into holding privileges.

| Role | Purpose | Rights |
|---|---|---|
| `organic_os_migrator` | owns all objects, performs DDL | `CREATE` on database and schema `public`. **No data policies**, so with FORCE RLS it cannot read or write tenant rows |
| `organic_os_runtime` | the API and worker role | DML on tenant tables under RLS; `SELECT` only on `users`; `SELECT`+`UPDATE` on its own `organizations` row; `SELECT`+`INSERT` only on `audit_logs`; `SELECT` on `feature_flags`; full DML on `sessions`. No DDL |
| `organic_os_provisioner` | creates organizations and users | `INSERT/UPDATE/DELETE` on `organizations` and `users` via role-targeted policies; memberships under tenant context. No DDL |

The application never connects as `postgres` or as the owner.

## 5. Row Level Security

Pattern: `organization_id = app.current_org_id()` as both `USING` and `WITH CHECK`,
so a row can neither be read from, created in, nor moved to another organization.

`app.current_org_id()` reads `current_setting('app.current_org_id', true)` and returns
NULL when unset — every policy then matches nothing, so **absent context fails
closed** rather than opening up.

- **Enabled and FORCED:** `organizations`, `users`, `memberships`,
  `membership_client_scopes`, `clients`, `sites`, `site_settings`, `integrations`,
  `integration_tokens`, `audit_logs`.
- **No RLS, intentionally:**
  - `sessions` — not tenant-scoped. A session is resolved from a token hash *before*
    any organization is known, so a tenant predicate cannot be evaluated.
  - `feature_flags` — global platform configuration, not tenant data; runtime reads it.

Because FORCE applies to the owner too, the migration role has no data access at all.
A future data-backfilling migration must therefore handle this explicitly (temporarily
lifting FORCE inside that migration, or writing through a policy) — a deliberate,
visible cost of the stronger default.

## 6. TenantContext

```ts
withTenantTransaction(db, tenant, async (repositories) => { … })
```

1. The context is validated (`organizationId` must be a UUID) before a connection is
   used; an invalid or missing context throws `InvalidTenantContextError`.
2. `set_config('app.current_org_id', <id>, true)` — the parameterisable form of
   `SET LOCAL`. Discarded at COMMIT **and** ROLLBACK, so it can never survive a
   connection returning to the pool. Session-level `SET` appears nowhere in the
   package, and connection timeouts are passed as connection options rather than
   issued as session statements.
3. The callback receives **repositories, never a raw SQL handle**. The package root
   does not export the Drizzle table objects, so application code cannot assemble an
   unscoped query.
4. Repositories read the organization from the context and never from their
   arguments — no `create`/`update` input accepts an `organizationId`, so a caller
   cannot widen its own scope by supplying one.

**Worker trust rule (prepared, not built):** because organization comes only from the
context, a future queue payload cannot authorize itself. Deriving a context from a
trusted persisted record is a sub-phase 0.5 concern; when it lands it will need a
narrowly-scoped lookup, since FORCE RLS means even the owner cannot read `sites`
without context. Options to weigh then: a `SECURITY DEFINER` resolver owned by a role
that may bypass RLS for that single lookup, or resolving through the provisioning
role. No such path exists today.

## 7. IDs, indexes and settings

- **UUIDv7** via the `uuid` package (`v7`), generated application-side because
  PostgreSQL only gained built-in `uuidv7()` in v18 and the platform targets 16+.
  Time-ordered keys keep inserts at the right edge of the index. No ID service.
- **Indexes** are tenant-leading and limited to current access patterns:
  `organization_id` on every scoped table, `(organization_id, client_id)` on sites,
  `(organization_id, provider)` on integrations, `(organization_id, created_at DESC)`
  on audit logs, plus the identity lookups on `memberships` and `sessions`. Nothing
  speculative for future SEO workloads.
- **JSONB settings** have typed Zod schemas (`graduation_policy`,
  `ingestion_overrides`, `retention_overrides`) that reject unknown keys. Stored
  objects are *overrides*; the recommended baselines
  (`DEFAULT_GRADUATION_POLICY` = 20 green actions, all QA passed, zero incidents,
  zero unresolved rollback failures, explicit opt-in) live in code as configurable
  defaults, never as database constants.

## 8. Integration tokens

Table only. `ciphertext bytea`, `key_version`, `algo` — there is no column in which a
plaintext credential could be placed, no repository writes to it, and **no encryption
is implemented or simulated**. Envelope encryption belongs to sub-phase 0.6
(SECURITY.md §5); the persistence shape is ready for it.

## 9. Verification

All gates pass: `format:check`, `lint`, `typecheck`, unit tests (70 repo-wide, 32 in
this package), `build`, `test:integration` (34 tests) and
`pnpm audit --audit-level critical`.

The integration suite ran against **PostgreSQL 16 started by Testcontainers**
(`pgvector/pgvector:pg16`), exercising the real migration path: empty database →
bootstrap (extensions + roles) → migrations → seeded tenants → assertions.

**Environment note.** During implementation Docker Desktop's WSL2 data disk was
missing (`Failed to attach disk …\Docker\wsl\main\ext4.vhdx … ERROR_PATH_NOT_FOUND`),
so the suite could not run; it was executed once Docker Desktop was repaired. RLS was
never downgraded to SQLite or mocks, and the testing architecture was not replaced.

One durable addition came out of that episode:

> `TEST_DATABASE_ADMIN_URL` — when set, the integration suite runs against that
> PostgreSQL 16+ superuser connection instead of starting a container. Testcontainers
> remains the default and the CI path; this only changes *where* PostgreSQL comes
> from, never *what* is tested. The server must have pgvector available. (Note: the
> PostgreSQL 17 installed on this Windows host does **not** ship pgvector, so it
> cannot serve as that target without installing the extension.)

## 10. Tests (all passing)

**Unit (running, 32 passed):** tenant-context validation and fail-closed behaviour;
settings schemas incl. unknown-key rejection and baseline resolution; migration
checksum/normalisation/filename rules; connection descriptions that never expose
credentials; UUIDv7 format and ordering.

**Integration (34 passed against real PostgreSQL):**

| Requirement | Test |
|---|---|
| A repository isolation | A's repositories list/find only A's clients, sites, settings, memberships |
| B raw SQL isolation | runtime role + A context sees only A rows, including by primary key |
| C mutation isolation | A cannot update/delete B's rows (repository → null/false; SQL → 0 rows); victim row unchanged; forged audit entry rejected |
| D scope isolation | same-org scope succeeds; A-membership→B-client, B-membership→A-client and direct SQL all rejected |
| E pool safety | same backend PID reused; context is NULL after COMMIT and after ROLLBACK; queries return nothing without context; B context then sees only B |
| F fail closed | invalid/absent contexts throw before connecting; no-context reads return zero rows and writes are rejected |
| G forged identifiers | a caller-supplied `organizationId` is ignored; direct cross-org INSERT and org-move UPDATE are rejected |
| roles | runtime has no superuser/BYPASSRLS/CREATEDB/CREATEROLE; cannot DDL; cannot create organizations; cannot modify users; cannot UPDATE/DELETE audit_logs |
| RLS config | every tenant table enabled **and** forced; `sessions`/`feature_flags` confirmed without RLS; `citext` + `vector` present |
| migrations | empty → migrated; idempotent re-run; checksums recorded; edited-migration detection; **schema parity** between every Drizzle table and `information_schema` |

## 11. Known limitations and deferred work

- No authentication, RBAC enforcement, sessions logic, queues or feature-flag
  accessor — later sub-phases.
- The integration suite takes ~2 minutes locally (container start dominates); it runs
  as its own CI step, separate from the fast unit gate.
- No repository for `integrations`/`integration_tokens`: writing one before encryption
  exists would be a placeholder. RLS on both is still covered by raw-SQL assertions.
- Organization provisioning has no API path yet; the runtime role deliberately cannot
  create organizations. Sign-up must add an explicit privileged path in 0.3/0.4.
- `feature_flags` and `sessions` have no RLS by design (§5) and no repositories yet.
- Data-backfilling migrations will need to handle FORCE RLS explicitly (§5).

## 12. Deviations from the planning documents

| Deviation | Rationale |
|---|---|
| Migrations are hand-written rather than drizzle-kit generated (ADR-0003 says "generated, hand-reviewed") | Migrations must carry roles, RLS policies and grants, which drizzle-kit cannot express. One source of truth beats two, and a schema-parity test asserts the Drizzle definitions never drift from the migrated database. No drizzle-kit dependency was added. |
| A third role (`organic_os_provisioner`) beyond the required migration/runtime split | Tenant provisioning must not require DDL rights; without it, creating organizations would need the owner role. |
| Database env vars live in `packages/database`, not `packages/config` | Several are used only by the bootstrap CLI, and applications that never open a connection should not be forced to define them. |

## 13. Security findings

No secrets are committed. `.env.example` contains local-development-only values,
clearly labelled, for a loopback-bound container. Connection strings are never
logged — `describeConnection()` returns host/port/database only, and configuration
errors report variable *names*, never values (asserted by tests). Bootstrap rejects
unsafe identifiers and control characters in passwords rather than escaping around
them. No `any`, no `@ts-ignore`, no `eslint-disable` was introduced.

The strength of this design rests on the runtime role never gaining `BYPASSRLS` and
never being the object owner. Bootstrap re-asserts both on every run, and the
integration suite verifies them on every CI run — both now confirmed passing.
