# SUPABASE-STAGING.md
# Managed PostgreSQL for development/staging

Status: **project not created** — see §7 for the exact human action required.
Development/staging only. No production project exists and none is created by this
foundation.

---

## 1. Compatibility spike

Verified against Supabase's documented platform behaviour. Items marked **live** can
only be settled by running against the real project, and `pnpm db:verify:staging` is
the thing that settles them.

| Requirement | Finding | Source |
|---|---|---|
| PostgreSQL version | 17.x on new projects; the schema targets 16+ | project listing |
| `pgvector` | available; `CREATE EXTENSION IF NOT EXISTS vector` is supported | Supabase extensions |
| `citext` | available | Supabase extensions |
| Custom schemas (`app`) | supported — `postgres` may create schemas | roles/superuser guide |
| Custom functions (`app.current_org_id()` etc.) | supported | roles/superuser guide |
| RLS + policies | supported and encouraged | RLS guide |
| `FORCE ROW LEVEL SECURITY` | standard PostgreSQL, requires table ownership; the migrator owns the tables it creates | **live** |
| Custom roles | supported — `postgres` holds `CREATEROLE` | roles/superuser guide |
| `GRANT` / `REVOKE` | supported | roles/superuser guide |
| `set_config(..., true)` / `SET LOCAL` | standard PostgreSQL; the question is the **pooler**, see §3 | **live** |
| Triggers (`app.set_updated_at()`) | supported | roles/superuser guide |
| Migrations 0001–0005 | forward-only, no superuser-only statement identified | **live** |
| **True superuser** | **not available.** Documented unsupported operations are exactly two: `COPY ... FROM PROGRAM` and `ALTER USER ... WITH SUPERUSER` | [roles, superuser access and unsupported operations](https://supabase.com/docs/guides/database/postgres/roles-superuser) |

### Does anything we do require a superuser?

**No operation in migrations 0001–0005 does.** They are DDL, policies and grants issued
by the migration role, which owns its own objects.

`bootstrapDatabase()` is the only place that has ever needed elevated rights, and what
it actually needs is `CREATE EXTENSION`, `CREATE ROLE` and `GRANT` — all of which the
Supabase `postgres` role holds. It does **not** issue either unsupported operation. Its
one Supabase-specific risk is `search_path`, below.

### The one real compatibility risk: `citext` resolution

Managed platforms install extensions into a dedicated schema (`extensions`) rather than
`public`, and set `search_path` per role. A role **we create** does not inherit the
platform role's `search_path`. If `citext` is not resolvable, every statement touching
`users.email` or `organizations.slug` fails — including migration 0001.

- **Adaptation:** an administrative `ALTER ROLE <role> SET search_path = public, extensions`
  for each of the three roles, executed as part of **staging bootstrap**.
- **Not a migration.** This is environment configuration, not schema. Migrations
  0001–0005 stay byte-identical and their checksums stay valid. STEP 8's distinction
  applies exactly: a *platform* incompatibility gets a bootstrap-specific administrative
  step; only a *schema* change would justify a new forward migration.
- **Does it change the security architecture?** No. `search_path` is name resolution,
  not privilege. No role gains a capability.
- **Verified by:** the `types.resolvable` check in `pnpm db:verify:staging`, which runs
  `SELECT 'a'::citext = 'A'::citext` as the runtime role and fails loudly with the fix
  in the message.

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

## 7. Human action required

Creating a Supabase project is a billing-, region- and account-level decision. It has
not been done. See `docs/phases/CLOUD-0.1-IMPLEMENTATION.md` §"Remaining human actions"
for the exact steps and the values needed afterwards.
