# SUPABASE-STAGING.md
# Managed PostgreSQL for development/staging

Status: **project created and compatibility verified live; schema not yet applied.**
Project `organic-growth-os-dev` (`cxychekcsqcyzbgouviz`), region `eu-central-1`,
PostgreSQL 17.6, free tier. Development/staging only — no production project exists.
Bootstrap and migrations still need role passwords a human must choose (§7).

---

## 1. Compatibility spike

Verified **against the real project**, not inferred. Every row below was settled by a
query or a probe on `organic-growth-os-dev`; probe objects were created and then dropped,
leaving the database with only `citext` and `vector` installed and no tables.

| Requirement | Finding |
|---|---|
| PostgreSQL version | **17.6** — the schema targets 16+ |
| `pgvector` | available 0.8.2, **installed into `public`** |
| `citext` | available 1.6, **installed into `public`**; `'a'::citext = 'A'::citext` → true |
| Custom schema | `CREATE SCHEMA` succeeded |
| Custom functions | `current_setting(..., true)`-based resolver created |
| Triggers | `BEFORE UPDATE ... EXECUTE FUNCTION` created |
| RLS + policies | `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` succeeded |
| `FORCE ROW LEVEL SECURITY` | **`relforcerowsecurity = true`** on the probe table |
| Custom roles | `CREATE ROLE ... NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT` produced **exactly** those attributes |
| `GRANT` / `REVOKE` | `GRANT CONNECT`/`CREATE ON DATABASE` and `GRANT CREATE, USAGE ON SCHEMA public` all succeeded |
| `REVOKE CREATE ON SCHEMA public FROM PUBLIC` | already the state — PUBLIC holds no `CREATE` on `public` (PostgreSQL 15+ default), so the bootstrap statement is a harmless no-op |
| `set_config(..., true)` | set inside a transaction → visible; after the transaction ended → **NULL** |
| Database owner | `postgres` — so `GRANT CREATE ON DATABASE` works |
| `public` schema owner | `pg_database_owner`, and `postgres` is a member — so schema grants work |
| **True superuser** | **not available.** `postgres` is `rolsuper = false`, with `CREATEROLE`, `CREATEDB` and **`BYPASSRLS`**. Documented unsupported operations are exactly two: `COPY ... FROM PROGRAM` and `ALTER USER ... WITH SUPERUSER` |

### Does anything we do require a superuser?

**No operation in migrations 0001–0005 does.** They are DDL, policies and grants issued
by the migration role, which owns its own objects.

`bootstrapDatabase()` is the only place that has ever needed elevated rights, and what
it actually needs is `CREATE EXTENSION`, `CREATE ROLE` and `GRANT` — all of which the
Supabase `postgres` role holds. It does **not** issue either unsupported operation. Its
one Supabase-specific risk is `search_path`, below.

### The `citext` resolution risk did not materialise — and here is why

The risk was real and worth checking: managed platforms install extensions into a
dedicated `extensions` schema, and a role **we** create does not inherit the platform
role's `search_path`. If `citext` were unresolvable, migration 0001 would fail on
`users.email`.

It does not happen here. The `postgres` role's `search_path` is
`"$user", public, extensions`, and a `CREATE EXTENSION` with no `SCHEMA` clause lands in
the first usable entry — `public`. Both extensions were installed there deliberately, so
staging matches a local Docker database exactly and our roles (default `"$user", public`)
resolve `citext` with no extra configuration.

**Consequence: no adaptation is needed, and no migration was touched.** Should a future
project ever install them into `extensions` instead, the fix is an administrative
`ALTER ROLE <role> SET search_path = public, extensions` during staging bootstrap —
environment configuration, not schema, so migration checksums stay valid and no role
gains a privilege (`search_path` is name resolution). The `types.resolvable` check in
`pnpm db:verify:staging` fails loudly with that fix in its message.

### One finding that is a security note, not a blocker

**Supabase's `postgres` role holds `BYPASSRLS`.** It is not a superuser, but it can read
past every policy. That makes the bootstrap credential materially more powerful here than
the local `organic_os_admin`, and it is the reason `DATABASE_ADMIN_URL` appears in no
deployment, no CI environment and no Vercel variable
(`docs/cloud/ENVIRONMENT-MATRIX.md` §6). The three application roles we create are all
`NOBYPASSRLS`, verified by probe and re-asserted on every bootstrap.

### The Data API, and why our schema will not be exposed through it

Supabase auto-generates a PostgREST Data API over the `public` schema, reachable from a
browser with the `anon` key. Our schema lives in `public`, so this deserved a definite
answer rather than an assumption.

**It will not expose our tables**, and the reason is structural: the default privileges
that grant `anon`, `authenticated` and `service_role` full access to new objects in
`public` are attached to objects created by **`postgres`** and `supabase_admin`.
`pg_default_acl` carries **no entry for `organic_os_migrator`**, which is the role that
creates every one of our tables. Tables it creates therefore start with no grant to any
API role, and PostgREST — which connects as `anon` or `authenticated` — gets permission
denied before RLS is even consulted.

That is defence in depth on top of the model we already have: FORCE RLS, policies granted
`TO organic_os_runtime` only, and no `anon`/`authenticated` role anywhere in our
connection strings.

**Recommended anyway:** disable the Data API for this project (Dashboard → Project
Settings → API), because the smallest surface is no surface. It is a project setting, not
a repository change, so it is listed as a human action rather than done here.

### The `extension_in_public` advisory

Supabase's linter flags `citext` and `vector` as installed in `public`. The warning
exists because extension functions in `public` become callable through the Data API. In
this project that premise does not hold — the Data API cannot reach our objects (above),
and both extensions expose type operators rather than privileged operations. Keeping them
in `public` buys exact parity with a local Docker database and avoids a `search_path`
adaptation that would otherwise be needed. **If the Data API is ever enabled and used,
revisit this.**

## 2. Role model on Supabase

Unchanged from Phase 0.2. The three roles are created by `pnpm db:bootstrap` using the
Supabase `postgres` connection as `DATABASE_ADMIN_URL`:

| Role | Attributes | May |
|---|---|---|
| `organic_os_migrator` | NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS | own and alter schema objects |
| `organic_os_runtime` | NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS | read/write tenant data under FORCE RLS; no DDL; no INSERT on `organizations` or `users` |
| `organic_os_provisioner` | NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS | create organizations, users and first memberships; no DDL |

`bootstrapDatabase()` re-asserts these attributes on every run, so a role cannot drift
into holding `SUPERUSER` or `BYPASSRLS`. Supabase cannot grant `SUPERUSER` at all
(`ALTER USER ... WITH SUPERUSER` is unsupported), which makes the strongest attribute
unreachable by construction rather than by policy.

**`service_role` is not used.** It is a platform-wide RLS bypass; this architecture
denies exactly that. It appears in no connection string, no environment variable and no
code path.

**Not collapsed.** If a Supabase ownership restriction ever made the three-role model
impossible, the answer is the smallest secure equivalent — never one privileged
`postgres` connection serving application traffic. No such restriction has been
identified.

## 3. Connection modes — and why this is a security question

Supabase offers three connection paths with materially different properties:

| Mode | Host : port | IP | Notes |
|---|---|---|---|
| Direct | `db.<ref>.supabase.co:5432` | **IPv6 only** without the IPv4 add-on | migrations, `pg_dump`, long-lived backends |
| Supavisor session | `aws-<region>.pooler.supabase.com:5432` | IPv4 on every tier | persistent backends on IPv4-only networks |
| Supavisor transaction | `aws-<region>.pooler.supabase.com:6543` | IPv4 on every tier | serverless/short-lived clients; **no named prepared statements** |

Two consequences follow directly, and both are decisions rather than preferences:

1. **GitHub Actions runners and Vercel functions are IPv4-only.** A direct connection
   from either will simply fail to resolve. **CI and any deployed runtime must use the
   pooler host.** This is why `.env.example` documents pooler URLs for staging and
   localhost URLs for development.
2. **Transaction-mode pooling must be proven, not assumed.** The entire tenancy model
   rests on `BEGIN → set_config('app.current_org_id', …, true) → queries → COMMIT →
   context gone`. A transaction-mode pooler pins a server connection for the duration of
   a transaction, which makes this safe — but "documented as safe" is not the standard
   this architecture holds itself to.

   `pnpm db:verify:staging` proves it directly: it sets the context inside a
   transaction and confirms it is visible; commits; then reads `app.current_org_id()`
   twenty times across pooled checkouts and requires every one to be NULL. A single
   non-NULL read fails the run and says the connection mode is not safe for
   transaction-local tenancy.

   It also confirms parameterised queries work, because transaction mode rejects *named*
   prepared statements. `node-postgres` sends unnamed extended-protocol statements, so
   this passes — the check exists so a future driver change cannot break it silently.

**Recommended assignment** (settled once the project exists):

| Connection class | Mode | Why |
|---|---|---|
| `DATABASE_URL` (runtime) | Supavisor **session** 5432 from a long-lived container; **transaction** 6543 if ever serverless | the API keeps its own `pg.Pool`; session mode avoids double-pooling |
| `DATABASE_MIGRATOR_URL` | Supavisor session 5432 | CI is IPv4-only; migrations are one long-lived connection holding an advisory lock |
| `DATABASE_PROVISIONER_URL` | Supavisor session 5432 | operator CLI, short-lived |
| `DATABASE_ADMIN_URL` (bootstrap) | Supabase `postgres` role | one-off; never stored in a deployment |

### Transport security: verified TLS, or no connection

Found live during Cloud 0.1 rather than assumed, and it changed the code. `node-postgres`
negotiates **no TLS at all** unless it is handed SSL options, and Supabase ships with
*Enforce SSL* off "to maximise client compatibility". A connection string therefore said
nothing about whether anything on that socket was encrypted, and nothing in this
repository was setting SSL options.

Be precise about what that did and did not expose, because the distinction decides how
alarming it is. Authentication is `scram-sha-256` (verified on the live project), so the
role password is a challenge-response and was **never recoverable from the wire**. What
an unencrypted connection exposes is everything *after* authentication — every query,
every tenant row, every session token — to a passive observer, and the whole session to
an active man-in-the-middle, because nothing authenticates the server. **SCRAM protects
the credential; it protects no data.**

Two independent layers now close this, and each was verified against the live project:

| Layer | Mechanism | Verified by |
|---|---|---|
| Server | *Enforce SSL on incoming connections* is **on** | a plaintext connection is refused with `ESSLREQUIRED` on both 5432 and 6543 |
| Client | `packages/database/src/tls.ts` — a non-local connection gets `verify-full` or is refused | a connection with a deliberately wrong root CA is rejected; with the pinned root it reaches authentication |

`sslmode=require` is deliberately **not** what this implements. It encrypts without
authenticating the server, which stops passive snooping and does nothing about an active
man-in-the-middle — and it is what most "add SSL" advice reaches for. `verify-full`
requires the chain to terminate in the configured root *and* the hostname to match.

`DATABASE_SSL_ROOT_CERT` names that root, as an absolute path to a PEM file or the PEM
text itself. The root is committed at `certs/supabase-prod-ca-2021.crt` — a root CA is
public, so it is a variable and never a secret. The copy in the repository was checked
twice over: extracted from the live TLS handshake, and compared byte-for-byte against the
copy the dashboard serves over a publicly-trusted connection. They are identical
(SHA-256 `80:70:25:AD:…:72:E6:CA:FA`), which is what rules out trusting a certificate
merely because a server offered it.

Absence fails closed. An unset `DATABASE_SSL_ROOT_CERT` refuses a remote connection
rather than quietly downgrading it to plaintext — the failure this exists to make
impossible. Local development against Docker on `127.0.0.1` needs no certificate and
must not set one.

## 4. Environment separation

| Environment | Database | Migrations applied by |
|---|---|---|
| local / test | Docker Compose, or disposable Testcontainers in CI | `pnpm db:migrate` locally; the CI runner itself |
| **staging** | Supabase `organic-growth-os-dev` | manual `staging-database` workflow only |
| production | **does not exist** | — |

Local tests never point at staging: the integration suites create their own database
and refuse to do otherwise unless `TEST_DATABASE_ADMIN_URL` is set explicitly. The
staging verifier refuses to run unless `STAGING_DB_HOST` matches the host in every
connection string it was given.

## 5. Bootstrap and migration order on a fresh Supabase project

```bash
# 1. Extensions and roles. Uses the Supabase `postgres` connection; run once, by a human.
DATABASE_ADMIN_URL='postgres://postgres.<ref>:<pw>@<pooler-host>:5432/postgres' \
DATABASE_MIGRATOR_PASSWORD=... DATABASE_RUNTIME_PASSWORD=... DATABASE_PROVISIONER_PASSWORD=... \
pnpm db:bootstrap

# 2. If `types.resolvable` fails in step 4, make extensions reachable for our own roles.
#    Administrative, environment-only; NOT a migration.
#    ALTER ROLE organic_os_migrator     SET search_path = public, extensions;
#    ALTER ROLE organic_os_runtime      SET search_path = public, extensions;
#    ALTER ROLE organic_os_provisioner  SET search_path = public, extensions;

# 3. Schema. Forward-only, checksum-verified.
DATABASE_MIGRATOR_URL='...' pnpm db:migrate

# 4. Environment verification. Read-only and rolled-back; nothing is seeded or deleted.
STAGING_DB_HOST=... STAGING_DATABASE_URL='...' STAGING_DATABASE_MIGRATOR_URL='...' \
pnpm db:verify:staging
```

After step 1, `pnpm provision:organization` creates the first tenant (ADR-0018).

## 6. What `db:verify:staging` checks

Server version · `citext` and `vector` installed · `citext` resolvable on the runtime
`search_path` · role attributes for all three roles · RLS **and** FORCE RLS on all ten
tenant tables · runtime table grants are exactly `organizations: SELECT,UPDATE`,
`users: SELECT`, `audit_logs: SELECT,INSERT` · no `SECURITY DEFINER` function in schema
`app` · parameterised queries · tenant context visible inside its transaction · tenant
context gone after commit, twenty times · a foreign tenant context reads zero rows from
every tenant table · an authentication context establishes no tenant access · runtime
cannot create an organization, create a user, update or delete an audit row, perform DDL
or disable RLS · every migration applied with a matching checksum.

## 7. Live result (2026-09-01)

Everything below was executed against the real project, not inferred.

| Step | Result |
|---|---|
| `pnpm db:bootstrap` | extensions and three roles in place |
| `pnpm db:migrate` | **0001–0005 applied** |
| `pnpm db:status` | 5 applied, **0 pending** |
| `pnpm db:verify:staging` | **25 passed, 0 failed, 0 skipped** |

Role attributes read back from `pg_roles` — none of the three holds `SUPERUSER`,
`BYPASSRLS`, `CREATEDB`, `CREATEROLE` or `REPLICATION`, and the roles were not collapsed:

| Role | `rolsuper` | `rolbypassrls` | `rolcreatedb` | `rolcreaterole` | `rolreplication` |
|---|---|---|---|---|---|
| `organic_os_migrator` | f | f | f | f | f |
| `organic_os_runtime` | f | f | f | f | f |
| `organic_os_provisioner` | f | f | f | f | f |

**Enforce SSL is on** and **the Data API is disabled** (§3, §1). Both were verified from
outside rather than trusted: a plaintext connection is refused with `ESSLREQUIRED`, and a
valid publishable key against `/rest/v1/` now returns `Secret API key required`.

### One real defect this run found, in the verifier itself

The first live run reported `postgres.version` as **failing** on a PostgreSQL 17.6
server. The environment was fine; the check was not. `SHOW server_version` returns its
value in a column named `server_version`, and the code read `.version` — so it got
`undefined`, parsed `NaN`, and failed a comparison it should have passed. It had never
run against a real server before, which is exactly the class of bug a live verification
exists to surface.

Fixed by reading `current_setting('server_version_num')` — the integer the server
computes for precisely this comparison (`170006`) — instead of parsing a display string
that may carry a distribution suffix. **The check was corrected, not relaxed:** it still
demands PostgreSQL 16 or newer, now expressed as `>= 160000`.

## 8. Human action still required

Nothing on the Supabase side. The remaining Cloud 0.1 item is the Vercel project, which
needs a Vercel account authenticated as the GitHub user that owns the repository — see
`docs/cloud/VERCEL-STAGING.md`.

No credential of any kind is stored in this repository.
