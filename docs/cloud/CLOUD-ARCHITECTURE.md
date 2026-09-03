# CLOUD-ARCHITECTURE.md
# Organic Growth OS — Cloud Foundation

Status: **GitHub live and CI green; Supabase staging verified; Vercel deployed;
`apps/api` hosting decided and the repository ready, service not yet created**
(2026-09-02). See `docs/phases/CLOUD-0.1-IMPLEMENTATION.md`,
`docs/phases/CLOUD-0.2A-IMPLEMENTATION.md` and
`docs/phases/CLOUD-0.2-IMPLEMENTATION.md`.

The goal of this foundation is narrow: **remove the local Windows/Docker environment as
a single point of failure.** It changes where things run. It changes nothing about how
they work.

---

## 1. Target topology

```
GitHub
  ├── source control
  └── GitHub Actions
        ├── CI  ── disposable PostgreSQL (Testcontainers) ── AUTHORITATIVE verifier
        └── staging-database (manual dispatch only) ── migrations + env verification

Vercel
  └── apps/web (Next.js)            ── app.<domain>, browser-facing, no database credential

Render (Cloud 0.2)
  └── apps/api (Fastify, Docker)    ── api.<domain>, one always-on instance, Frankfurt,
                                       long-lived pool, argon2id, transaction-local tenancy

Supabase
  └── managed PostgreSQL 17 + pgvector + citext   ── development/staging only

Not yet deployed
  └── apps/worker                   ── queue/crawler/Playwright, Cloud 0.3+
```

**Web and API are sibling subdomains of one registrable domain, and that is a security
decision rather than a naming convention.** Session and CSRF cookies carry the
`__Host-` prefix and `SameSite=Lax`, and `AuthCookiePolicy.sameSite` deliberately has
no `'none'`. On two unrelated platform domains — `*.vercel.app` and `*.onrender.com`,
both on the Public Suffix List — the browser would simply not send the session cookie.
One registrable domain makes the two origins same-site, so every cookie property stays
exactly as designed. The alternative (a same-origin proxy through Vercel) and why it
was not chosen are in `docs/cloud/API-STAGING.md` §7.

## 2. What did not change, and why that is the point

Cloud Foundation 0.1 adapts to the existing architecture rather than the reverse.
Everything below is unchanged, and each is load-bearing:

- **Authentication stays ours.** Argon2id, opaque server-side sessions, SHA-256 token
  hashes, custom CSRF, revocation. Supabase Auth is not installed, `auth.uid()` is not
  used, and no Supabase JWT is an `AuthenticatedIdentity` (ADR-0013).
- **Data access stays ours.** Drizzle over `pg`, tenant-scoped repositories, the
  canonical `withAuthorizedOrganization` transaction. No Supabase client library, no
  PostgREST, no Data API in the application path.
- **Isolation stays ours.** RLS + `FORCE ROW LEVEL SECURITY` on every tenant table,
  transaction-local `app.current_org_id`, composite tenant foreign keys, append-only
  `audit_logs` by privilege (ADR-0002, migration 0002).
- **The three-role model stays.** `organic_os_migrator` / `organic_os_runtime` /
  `organic_os_provisioner`, none of them superuser, none with `BYPASSRLS`.
- **`service_role` is never used.** Supabase's `service_role` JWT is a
  platform-wide RLS bypass by design, which is the exact property this architecture
  exists to deny. It has no place in this system.
- **Migrations 0001–0005 are untouched.** Their checksums are immutable; the runner
  verifies them on every run.

## 3. The division of verification labour

This distinction is the most important decision in this foundation.

| | GitHub Actions CI | Supabase staging |
|---|---|---|
| Database | created, migrated and destroyed inside the runner | long-lived, shared, accumulates state |
| Proves | the **logic**: tenant isolation, authorization, membership administration, session revocation, audit integrity, concurrency, provisioning | the **environment**: privileges, extensions, FORCE RLS, grants, pooler transaction semantics |
| Authority | **authoritative.** A security property is verified here or it is not verified | supporting. Confirms the platform gave us what the architecture assumes |
| Trigger | every push and pull request | manual dispatch only |
| Holds a staging credential | no | yes, from the `staging` GitHub Environment |

Staging can be green because of data. A disposable database built from migration 0001
cannot be. That is why CI remains the clean room, and why `pnpm db:verify:staging`
checks the platform rather than re-running the suite.

## 4. Where the API runs, and why not on Vercel

**Decision: `apps/web` on Vercel; `apps/api` stays a separately deployable service.**

Four properties of the API make serverless the wrong shape for it, and none of them is
a preference:

1. **A long-lived connection pool is part of the security design.** Tenant context is
   `set_config(..., true)` inside an explicit transaction. That is safe behind a
   transaction-mode pooler, but a per-invocation function multiplies client-side pools
   with no way to bound them, and the failure mode is connection exhaustion on a shared
   staging database.
2. **Argon2id is deliberately expensive.** 19 MiB and two iterations per login is the
   OWASP baseline and the reason a stolen hash table is not a breach. Paying it inside a
   metered function, on a cold start, with a native module (`@node-rs/argon2`) in the
   bundle, is a cost and latency problem with no security upside.
3. **The worker shares these packages.** `apps/worker` runs BullMQ, a crawler and
   Playwright (ADR-0005, ADR-0006). It is a container workload and always will be.
   Splitting the API into a different runtime shape than the worker that shares its
   domain packages buys nothing and costs a second deployment model.
4. **ARCHITECTURE.md §2.1 already says so.** "One web deployment, one API deployment,
   N worker containers." Cloud 0.1 is not the place to reopen that.

Consequence for this foundation: **Vercel receives no database credential.** The web
deployment is a browser-facing Next.js app with one public variable. That is the
smallest correct surface, and it is why preview deployments are safe by construction
rather than by policy (§5).

The API's own hosting target is **Render, Frankfurt, Docker, one always-on instance**,
chosen in Cloud 0.2. The reasoning, the alternatives and the cost posture are in
`docs/cloud/API-STAGING.md` §2.

## 5. Preview safety

Vercel preview deployments are the default risk in this shape: every pull request gets a
live environment, and if that environment holds a migration or provisioning credential,
every contributor can reshape the shared database.

The model here removes the question rather than answering it:

- Vercel holds **no** `DATABASE_*` variable of any class, in Cloud 0.1 or after Cloud
  0.2. Its only variables are `NEXT_PUBLIC_APP_NAME` and `NEXT_PUBLIC_API_BASE_URL`,
  both public by definition.
- The Render service's pull-request previews are **off**, for the same reason: a
  preview would need that service's environment to be useful, and that environment
  holds the runtime database credential and the session secret.
- The only workflow holding a staging credential is `staging-database.yml`, which is
  `workflow_dispatch`-only and bound to the `staging` GitHub Environment. It has no
  `push` and no `pull_request` trigger, so no branch and no preview can invoke it.
- Migrations never run from a web request. There is no startup migration and no
  auto-migrate path — the runner is reachable only from the CLI (ADR-0003).

When the API is deployed (Cloud 0.2) and previews need real data, the answer is an
isolated preview database (Supabase branching), never shared staging with elevated
credentials.

## 6. Cost posture

One Supabase project, one Vercel project, one Render service on its smallest always-on
instance, GitHub Actions on the free tier. No replicas,
no analytics vendor, no Redis, no paid queue, no second database. Supabase free-tier
projects pause after inactivity, which is acceptable for staging and is the reason
`db:verify:staging` is run explicitly rather than on a schedule.

## 7. Object storage

Not integrated, and deliberately. `StorageProviderInterface` (ADR-0011) is the seam;
Supabase Storage is a **candidate provider** behind it, alongside S3. The first artifact
that needs storing — a crawl snapshot, a screenshot, a report — arrives in a later
phase, and the integration belongs to that phase. No speculative storage code exists.

## 8. Related documents

- `docs/cloud/SUPABASE-STAGING.md` — database compatibility, roles, connection modes
- `docs/cloud/VERCEL-STAGING.md` — web deployment settings and the API decision
- `docs/cloud/API-STAGING.md` — where the API runs, its trust boundary, cookies and CORS
- `docs/cloud/ENVIRONMENT-MATRIX.md` — every variable, its class, and where it may live
- `docs/phases/CLOUD-0.1-IMPLEMENTATION.md` — what was done, what is blocked
