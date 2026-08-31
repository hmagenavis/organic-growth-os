# CLOUD-0.1 — GitHub + Supabase dev/staging + Vercel dev/staging (implementation record)

Status: **BLOCKED — repository work complete, no cloud resource created** (2026-08-31)
Scope: remove the local Windows/Docker environment as a single point of failure.

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

- Repository initialised, branch `main`, working tree clean.
- **No `origin` remote.** Nothing has been pushed and no repository has been created:
  the account is a human choice and `gh` is authenticated for two of them (§9).
- Phase 0.4.2A was committed locally so it can reach CI (`f0aaad8`).
- `ci.yml` is unchanged in substance and remains the authoritative verifier: format,
  lint, typecheck, unit tests, **`pnpm test:integration` against disposable PostgreSQL
  via Testcontainers**, build, critical audit. `workflow_dispatch` was added so a
  verification result can be refreshed without an empty commit.
- It holds no cloud credential. The workflow that does is manual-dispatch only.

## 3. Supabase

**No project was created.** Four projects exist in the account's single organization,
all paused and all belonging to unrelated products; none was touched, because a
verification run against a database nobody identified as staging is exactly what STEP 20
forbids.

Compatibility spike (documented sources, not assumptions):
`docs/cloud/SUPABASE-STAGING.md` §1. Summary:

- PostgreSQL 17 on new projects; the schema targets 16+.
- `pgvector` and `citext` are both available.
- Custom schemas, functions, triggers, RLS, `GRANT`/`REVOKE`, and custom roles are
  supported; `postgres` holds `CREATEROLE`.
- **No superuser.** Supabase documents exactly two unsupported operations —
  `COPY ... FROM PROGRAM` and `ALTER USER ... WITH SUPERUSER`. **Neither appears in
  migrations 0001–0005 or in `bootstrapDatabase()`.** Nothing we do requires a
  superuser.
- One real risk, and it is not a schema problem: **`citext` resolution.** Managed
  platforms install extensions into an `extensions` schema, and a role *we* create does
  not inherit the platform role's `search_path`. The adaptation is an administrative
  `ALTER ROLE … SET search_path = public, extensions` during staging bootstrap — **not**
  a migration edit, and not a security change, because `search_path` is name resolution
  rather than privilege. The `types.resolvable` check fails loudly with that fix in its
  message.

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
| `pnpm test` | **466 passing**, up from 460 (6 new readiness tests) |
| `pnpm build` | clean |
| `pnpm audit --audit-level critical` | no known vulnerabilities |
| GitHub Actions CI | **not run** — no remote exists yet |
| `pnpm db:verify:staging` | **not run** — no staging project exists yet |

## 9. Remaining human actions

Each is a point where an account, a billing decision or an interactive login is
required, so none was guessed at.

**A. GitHub repository.** `gh` is authenticated for two accounts — `hmagenavis`
(active) and `FLYBACK770`. Creating a repository under the wrong one is not something to
resolve by picking. Once the account and visibility are chosen:

```bash
gh repo create <account>/organic-growth-os --private --source . --remote origin --push
```

This is what unblocks Phase 0.4.2A verification: the first push runs the integration
suites that Docker cannot run locally.

**B. Supabase project.** Region and cost are the user's decision; the account has one
organization (`avisrismusic-star's Org`). Suggested name `organic-growth-os-dev`, region
matching the intended audience. Afterwards, the connection strings are needed for
bootstrap and for the `staging` GitHub Environment.

**C. Vercel project.** Requires `npm i -g vercel` and an interactive `vercel login`,
then linking with Root Directory `apps/web`. No Vercel CLI is installed on this machine.

**D. GitHub `staging` Environment.** After B: create the Environment, add
`STAGING_DB_HOST` as a *variable* and the connection strings as *secrets*, and consider
required reviewers on it.

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
