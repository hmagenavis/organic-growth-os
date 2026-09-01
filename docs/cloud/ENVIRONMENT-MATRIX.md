# ENVIRONMENT-MATRIX.md
# Every variable, its class, and where it is allowed to exist

The rule this table encodes: **a credential exists in the fewest places that can still
do the job.** Migration and provisioning credentials in particular never reach a
serving process — not because a request handler would misuse them, but because a
process that cannot reshape the schema cannot be made to.

Legend for locations: **Local** = a developer's `.env` · **CI** = GitHub Actions
repository/environment secrets · **Vercel** = the web deployment · **API host** =
wherever `apps/api` runs (Cloud 0.2) · **Operator** = a human's shell, transiently.

---

## 1. PUBLIC — inlined into the browser bundle, world-readable

| Variable | Local | CI | Vercel | API host | Operator |
|---|---|---|---|---|---|
| `NEXT_PUBLIC_APP_NAME` | ✓ | — | ✓ | — | — |

`packages/config/src/client.ts` is the only schema that may ever contain these, it
accepts nothing but `NEXT_PUBLIC_*`, and it strips unknown keys so a secret passed in by
accident cannot survive into the returned object. **Never put a secret under
`NEXT_PUBLIC_*`** — the prefix is an instruction to the bundler to publish it.

## 2. SERVER_ONLY — non-secret runtime configuration

| Variable | Local | CI | Vercel | API host | Operator |
|---|---|---|---|---|---|
| `NODE_ENV` | ✓ | ✓ | ✓ | ✓ | — |
| `LOG_LEVEL` | ✓ | — | — | ✓ | — |
| `SERVICE_VERSION` | ✓ | — | ✓ | ✓ | — |
| `API_HOST` / `API_PORT` | ✓ | — | — | ✓ | — |
| `WORKER_HEARTBEAT_INTERVAL_MS` | ✓ | — | — | — | — |
| `DATABASE_SSL_ROOT_CERT` | staging only | ✓ (`staging` env) | — | ✓ | ✓ |

`DATABASE_SSL_ROOT_CERT` is the root certificate a **non-local** database connection must
chain to, as an absolute path to a PEM file or the PEM text itself. It is a **variable,
never a secret** — a root CA is published precisely so it can be distributed — and the
Supabase root is committed at `certs/supabase-prod-ca-2021.crt`, so in CI it is a path
rather than a stored value. It is what makes a managed connection `verify-full` rather
than merely encrypted, and its absence refuses the connection rather than downgrading it
(`packages/database/src/tls.ts`, `docs/cloud/SUPABASE-STAGING.md` §3). Local development
against Docker on `127.0.0.1` neither needs nor sets it.

## 3. DATABASE_RUNTIME — the RLS-constrained application connection

| Variable | Local | CI | Vercel | API host | Operator |
|---|---|---|---|---|---|
| `DATABASE_URL` | ✓ | — | **never** | ✓ | — |
| `DATABASE_MAX_CONNECTIONS` | ✓ | — | — | ✓ | — |
| `DATABASE_STATEMENT_TIMEOUT_MS` | ✓ | — | — | ✓ | — |
| `DATABASE_IDLE_TX_TIMEOUT_MS` | ✓ | — | — | ✓ | — |

`DATABASE_URL` carries `organic_os_runtime`: no DDL, no `BYPASSRLS`, no `INSERT` on
`organizations` or `users`. It is the **only** database credential a serving process ever
holds. Not set on Vercel in Cloud 0.1 because the web deployment does not talk to the
database at all.

## 4. DATABASE_MIGRATION — schema authority

| Variable | Local | CI | Vercel | API host | Operator |
|---|---|---|---|---|---|
| `DATABASE_MIGRATOR_URL` | ✓ | ✓ (`staging` env) | **never** | **never** | ✓ |

Reachable from exactly two places: a developer's machine against their own database, and
the manual `staging-database` workflow. **Not** in repository-wide secrets — in the
`staging` GitHub Environment, so it can carry required reviewers and a branch
restriction. The serving application never receives it, which is what makes "the web
server does not migrate on startup" a property rather than a promise.

## 5. DATABASE_PROVISIONER — tenant creation

| Variable | Local | CI | Vercel | API host | Operator |
|---|---|---|---|---|---|
| `DATABASE_PROVISIONER_URL` | ✓ | — | **never** | **never** | ✓ |

Creates organizations, users and first memberships (ADR-0018). Operator command line
only. There is no HTTP route behind it and no public sign-up, so this credential has no
reason to exist inside any deployment.

## 6. SUPABASE ADMIN / INFRA ONLY — bootstrap

| Variable | Local | CI | Vercel | API host | Operator |
|---|---|---|---|---|---|
| `DATABASE_ADMIN_URL` | ✓ | — | **never** | **never** | ✓ |
| `DATABASE_MIGRATOR_PASSWORD` | ✓ | — | **never** | **never** | ✓ |
| `DATABASE_RUNTIME_PASSWORD` | ✓ | — | **never** | **never** | ✓ |
| `DATABASE_PROVISIONER_PASSWORD` | ✓ | — | **never** | **never** | ✓ |

Used once, by `pnpm db:bootstrap`, to create extensions and roles. On Supabase this is
the `postgres` connection. It is not stored in any deployment or CI environment.

**Supabase keys that are deliberately absent everywhere:** `SUPABASE_SERVICE_ROLE_KEY`
(a platform-wide RLS bypass — the exact property this architecture denies),
`SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_URL` and every other Data-API credential. No
Supabase client library is installed, and Supabase Auth is not used
(`docs/cloud/CLOUD-ARCHITECTURE.md` §2).

## 7. AUTH_SECRET and auth configuration

| Variable | Class | Local | CI | Vercel | API host |
|---|---|---|---|---|---|
| `AUTH_SESSION_SECRET` | **secret** | ✓ (dev value) | ✓ (test value) | **never** | ✓ |
| `AUTH_SESSION_ABSOLUTE_LIFETIME_MS` | config | ✓ | — | — | ✓ |
| `AUTH_SESSION_IDLE_TIMEOUT_MS` | config | ✓ | — | — | ✓ |
| `AUTH_SESSION_TOUCH_INTERVAL_MS` | config | ✓ | — | — | ✓ |
| `AUTH_SESSION_CLEANUP_GRACE_MS` | config | ✓ | — | — | ✓ |
| `AUTH_COOKIE_SECURE` | config | ✓ | — | — | ✓ |
| `AUTH_COOKIE_SAME_SITE` | config | ✓ | — | — | ✓ |
| `AUTH_LOGIN_RATE_LIMIT_*` | config | ✓ | — | — | ✓ |
| `AUTH_ARGON2_*` | config | ✓ | ✓ (cheap test cost) | — | ✓ |

`AUTH_SESSION_SECRET` keys the CSRF token MAC. Rotating it invalidates outstanding CSRF
tokens; it does not invalidate sessions. Production refuses to start with insecure
cookie settings, so `AUTH_COOKIE_SECURE=false` cannot reach a production deployment.

## 8. CI ONLY

| Variable | Where | Purpose |
|---|---|---|
| `TEST_DATABASE_ADMIN_URL` | optional, local | run integration tests against an existing PostgreSQL instead of Testcontainers |
| `STAGING_DB_HOST` | `staging` environment **variable** (not a secret) | guard: the verifier refuses unless every connection string matches this host |
| `STAGING_DATABASE_URL` | `staging` environment secret | runtime connection, for environment verification |
| `STAGING_DATABASE_MIGRATOR_URL` | `staging` environment secret | migrations + checksum verification |
| `STAGING_DATABASE_PROVISIONER_URL` | optional, operator | provisioner attribute checks |

CI's own integration database needs no credential at all: Testcontainers creates it,
bootstraps roles with throwaway passwords defined in `packages/database/src/testing`,
migrates it and destroys it.

## 9. Handling rules

- Never commit a real value. `.env` is git-ignored; `.env.example` carries only
  local-development placeholders, and every one of them says so.
- Never log a connection string. `describeConnection()` returns host, port and database
  name and is the only thing that reaches a log line.
- Never print a password, a session token, a token hash, a CSRF token or a `Cookie`
  header. `packages/observability` redacts; the CLIs log identifiers only.
- Redact when pasting verification output into an issue or a review.
- A variable's absence must fail closed. Every schema in `packages/config`,
  `packages/auth` and `packages/database` validates at startup and refuses to run rather
  than defaulting to something permissive.
