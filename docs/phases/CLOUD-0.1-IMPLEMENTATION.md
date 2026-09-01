# CLOUD-0.1 — GitHub + Supabase dev/staging + Vercel dev/staging (implementation record)

Status: **PARTIAL — GitHub live and CI green; Supabase project created and verified;
Vercel not created** (2026-09-01)
Scope: remove the local Windows/Docker environment as a single point of failure.

**The primary objective is met.** Phase 0.4.2A, which could not be verified on the
development machine, is now verified in GitHub Actions against real PostgreSQL.

Every change is additive and adapts to the existing architecture. **No security module
was rewritten, no migration was edited, no ADR was superseded.**

---

## 1. What was implemented

| Area | Where |
|---|---|
| Managed-environment verifier (read-only + rolled back) | `packages/database/src/staging/verify.ts` |
| `pnpm db:verify:staging` | `packages/database/src/cli/verify-staging.ts` |
| Database readiness probe | `packages/database/src/readiness.ts` |
| `GET /health/ready` (liveness vs readiness) | `apps/api/src/routes/health.ts` |
| Readiness response contract | `packages/contracts/src/health.ts` |
| Manual staging migration workflow | `.github/workflows/staging-database.yml` |
| CI note + manual re-run trigger | `.github/workflows/ci.yml` |
| Vercel build settings, in source control | `apps/web/vercel.json` |
| Staging variables, documented and commented | `.env.example` |
| Cloud documentation | `docs/cloud/*.md` |

## 2. GitHub

- Repository: **https://github.com/hmagenavis/organic-growth-os** (public, `main`).
- Three commits pushed: Phase 0.4.2A (`f0aaad8`), Cloud Foundation 0.1 (`51a502b`),
  and the integration-fixture fixes CI exposed (`dca344c`).
- Before pushing a public repository, the tree was scanned for committed credentials.
  `.env` is git-ignored; only `.env.example` is tracked and every value in it is a
  documented local placeholder. Every other match was code or a labelled test fixture.
- **CI is green** (run `33485884835`).

### Phase 0.4.2A verification — the point of this foundation

| Suite | Result |
|---|---|
| Unit (whole workspace) | 466 passing |
| `packages/database` integration (10 files) | **193 passing** |
| `apps/api` integration (3 files) | **42 passing** |

The first run (`33485213688`) failed 13 tests, and every one was a defect in the *test
harness* rather than the product — each was a security control refusing a fixture that
had not respected it: the `client_viewer` CHECK constraint rejecting a widened access
mode, and Row Level Security returning zero rows to fixture queries that set no tenant
context. Fixed in `dca344c`; no production code changed. Detail in
`PHASE-0.4.2A-IMPLEMENTATION.md` §15.

That is precisely the value CI was introduced to provide: these suites had never
executed anywhere.

## 3. Supabase

**Project created:** `organic-growth-os-dev` (`cxychekcsqcyzbgouviz`), `eu-central-1`,
PostgreSQL **17.6**, free tier ($0/month). Development/staging only; no production
project exists. The four pre-existing projects in the account were not touched.

The compatibility spike was run **against the real project**, not inferred. Full table in
`docs/cloud/SUPABASE-STAGING.md` §1. Everything the architecture needs works:

- `citext` 1.6 and `vector` 0.8.2 installed into `public`, so staging matches a local
  Docker database exactly.
- A probe role created with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
  NOREPLICATION NOINHERIT` came back holding **exactly** those attributes.
- `CREATE SCHEMA`, custom functions, triggers, `ENABLE`/`FORCE ROW LEVEL SECURITY`,
  `CREATE POLICY`, and the `GRANT`s bootstrap issues all succeeded.
  `relforcerowsecurity` was `true` on the probe table.
- `set_config(..., true)` was visible inside its transaction and **NULL** afterwards.
- The database is owned by `postgres` and `public` by `pg_database_owner` (of which
  `postgres` is a member), so every bootstrap grant works. `REVOKE CREATE ON SCHEMA
  public FROM PUBLIC` is already the state on PostgreSQL 15+, making that statement a
  no-op.
- **No superuser-only operation exists anywhere in our migrations or bootstrap.** The two
  operations Supabase documents as unsupported — `COPY ... FROM PROGRAM` and
  `ALTER USER ... WITH SUPERUSER` — appear nowhere in this repository.

Every probe object was dropped afterwards. The database now contains the two extensions,
no tables and no `organic_os_*` roles — pristine for the real bootstrap.

**The `citext` risk did not materialise.** It was worth checking, and the answer is that
`postgres` has `search_path = "$user", public, extensions`, so a `CREATE EXTENSION` with
no `SCHEMA` clause lands in `public`, where our roles' default search path finds it. **No
adaptation was needed and no migration was touched.**

**One security finding:** Supabase's `postgres` role is not a superuser but **does hold
`BYPASSRLS`**. That makes the bootstrap credential more powerful here than the local
`organic_os_admin`, and it is why `DATABASE_ADMIN_URL` appears in no deployment, no CI
environment and no Vercel variable. The three roles we create are all `NOBYPASSRLS`.

**Second security finding, and it resolves well:** Supabase auto-generates a PostgREST
Data API over `public`, which is where our schema will live. It will **not** expose our
tables. The default privileges granting `anon` / `authenticated` / `service_role` access
to new objects in `public` are attached to objects created by `postgres`; `pg_default_acl`
has no entry for `organic_os_migrator`, which creates every one of our tables. PostgREST
connects as `anon`/`authenticated` and would be refused on privilege, before RLS is even
consulted. Disabling the Data API entirely is still recommended as defence in depth and is
listed as a human action.

**Third:** the linter's `extension_in_public` warning for `citext` and `vector` is
accepted deliberately — its premise is Data API exposure, which does not apply here, and
`public` buys exact parity with a local Docker database (`SUPABASE-STAGING.md` §1).

**Not yet done:** bootstrap, migrations and `pnpm db:verify:staging` — all three need
role passwords a human must choose (§9).

## 4. Connection strategy

The finding that drives it: **Supabase direct connections (`db.<ref>.supabase.co:5432`)
are IPv6-only without the IPv4 add-on, and both GitHub Actions runners and Vercel
functions are IPv4-only.** CI and any deployed runtime must therefore use the Supavisor
pooler host. Assignment table in `docs/cloud/SUPABASE-STAGING.md` §3.

The three connection classes are unchanged and keep their existing names — renaming
`DATABASE_URL` to `DATABASE_RUNTIME_URL` would be churn across the config schema, the
CLIs, `.env.example`, the README and four phase records, and the class is already
explicit in every one of them:

| Class | Variable | Role |
|---|---|---|
| runtime | `DATABASE_URL` | `organic_os_runtime` |
| migration | `DATABASE_MIGRATOR_URL` | `organic_os_migrator` |
| provisioner | `DATABASE_PROVISIONER_URL` | `organic_os_provisioner` |
| bootstrap | `DATABASE_ADMIN_URL` | Supabase `postgres`, one-off |

**Pool safety is verified, not assumed.** `db:verify:staging` sets the tenant context
inside a transaction, confirms it is visible, commits, then reads `app.current_org_id()`
twenty times across pooled checkouts and requires every one to be NULL. One non-NULL
read fails the run and reports the connection mode as unsafe for transaction-local
tenancy. It also confirms parameterised queries work, since transaction-mode pooling
rejects *named* prepared statements.

## 5. Vercel

**Decision: `apps/web` on Vercel; `apps/api` stays a separately deployable service**
(Option B). Reasoning in `docs/cloud/CLOUD-ARCHITECTURE.md` §4 — a long-lived pool that
is part of the tenancy design, deliberately expensive Argon2id, a container-shaped
worker sharing the same packages, and ARCHITECTURE.md §2.1 already saying so.

The consequence is the security win: **Vercel holds no database credential in Cloud
0.1**, so preview deployments are safe by construction rather than by policy.

`apps/web/vercel.json` pins `installCommand` and `buildCommand`. Both are load-bearing:
workspace packages resolve to `dist/`, so `next build` alone fails, and
`--frozen-lockfile` makes lockfile drift a build failure. Project settings are in
`docs/cloud/VERCEL-STAGING.md` §2.

**No project was created** — it needs an authenticated account and a scope choice (§9).

## 6. Preview and migration safety

- `staging-database.yml` is `workflow_dispatch`-only, bound to the `staging` GitHub
  Environment, with `apply` defaulting to **false** so the default run is a read-only
  report. No `push` and no `pull_request` trigger exists, so no branch and no preview can
  invoke it.
- The migration credential lives in the `staging` Environment, not in repository
  secrets, so it can carry required reviewers and a branch restriction.
- Migrations never run from a web request; the runner is CLI-only (ADR-0003).

## 7. Health checks

`/health` is liveness — it touches no dependency, so a database outage does not make the
platform restart healthy processes. `/health/ready` is readiness, backed by a
`SELECT 1` that establishes no tenant context and reads no table. It answers a bare
`ready` / `not_ready` with 200/503 and **no reason, no dependency name and no error
text**: that endpoint is reachable by anyone who can reach the service, and "which
dependency is down" is topology. The detail goes to the structured log with the request
id. Six tests cover it, including one asserting the body contains none of `database`,
`postgres`, `connection`, `password`, `host` or `econnrefused`.

## 8. Verification

| Gate | Result |
|---|---|
| `pnpm format:check` | clean |
| `pnpm lint` | clean |
| `pnpm typecheck` | clean |
| `pnpm test` | **466 passing** |
| `pnpm build` | clean |
| `pnpm audit --audit-level critical` | no known vulnerabilities |
| **GitHub Actions CI** | **green** — run `33485884835`, all of the above plus **235 integration tests** against real PostgreSQL |
| Supabase compatibility spike | **verified live** against `organic-growth-os-dev` (§3) |
| `pnpm db:verify:staging` | **not run** — needs role passwords (§9) |
| Vercel deployment | **not created** (§9) |

## 9. Remaining human actions

Each is a point where a credential or an interactive login is required, so none was
guessed at.

**A. Supabase database password + role passwords.**
Dashboard → `organic-growth-os-dev` → Project Settings → Database → *Reset database
password* (shown once). Then choose three role passwords and run, from the repository
root:

```bash
DATABASE_ADMIN_URL='postgres://postgres.cxychekcsqcyzbgouviz:<db-password>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres' DATABASE_MIGRATOR_PASSWORD='<choose>' DATABASE_RUNTIME_PASSWORD='<choose>' DATABASE_PROVISIONER_PASSWORD='<choose>' pnpm db:bootstrap

DATABASE_MIGRATOR_URL='postgres://organic_os_migrator.cxychekcsqcyzbgouviz:<migrator-password>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres' pnpm db:migrate

STAGING_DB_HOST='aws-0-eu-central-1.pooler.supabase.com' STAGING_DATABASE_URL='postgres://organic_os_runtime.cxychekcsqcyzbgouviz:<runtime-password>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres' STAGING_DATABASE_MIGRATOR_URL='postgres://organic_os_migrator.cxychekcsqcyzbgouviz:<migrator-password>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres' pnpm db:verify:staging
```

Confirm the exact pooler host in the dashboard's *Connect* dialog — the region prefix
(`aws-0-` / `aws-1-`) varies by project. Use the **pooler** host, never
`db.<ref>.supabase.co`, which is IPv6-only.

**B. Optional, recommended: disable the Data API** on `organic-growth-os-dev`
(Dashboard → Project Settings → API). Not required — our tables are unreachable through
it by construction — but the smallest surface is no surface.

**C. GitHub `staging` Environment.** Repository → Settings → Environments → New
environment `staging`. Add `STAGING_DB_HOST` as a **variable** and
`STAGING_DATABASE_URL` / `STAGING_DATABASE_MIGRATOR_URL` as **secrets**. Consider
required reviewers — that is what turns the manual migration workflow into a reviewed
one.

**D. Vercel project.** Requires an interactive login; no Vercel CLI is installed here.

```bash
npm i -g vercel
vercel login
cd apps/web && vercel link
```

Then in the project settings: Root Directory `apps/web`, *Include files outside root
directory* on, Node 24.x, and one environment variable `NEXT_PUBLIC_APP_NAME`. Build and
install commands come from the checked-in `apps/web/vercel.json`.

## 10. Architecture changes

**NONE.** No ADR was superseded, no migration was edited, no security module was
modified. Authentication, authorization, the tenancy model, the three-role model and the
audit rules are untouched. `service_role`, Supabase Auth, the Data API and every Supabase
client library are absent from the repository.

## 11. Deferred

- Hosting for `apps/api` on a container platform (Cloud 0.2), with its runtime
  connection string, `AUTH_SESSION_SECRET` and production cookie settings.
- A custom domain and the same-origin arrangement `__Host-` cookies need.
- `apps/worker`, BullMQ, Redis, crawler, Playwright (Cloud 0.3+, ADR-0005/0006).
- Supabase Storage — a candidate provider behind `StorageProviderInterface` (ADR-0011),
  to be integrated by the phase that first has an artifact to store.
- Supabase branching for isolated preview databases, once previews need real data.
- Production environment. None exists and none was created.
