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
| `NEXT_PUBLIC_API_BASE_URL` | ✓ | — | ✓ | — | — |

`NEXT_PUBLIC_API_BASE_URL` is the origin of the API the browser talks to, e.g.
`https://api.example.com`. It is **infrastructure, not a credential**: a hostname the
browser must know to send a request at all, and knowing it grants nothing — the
session is a `__Host-` cookie the browser attaches to that origin. It is validated as
an *origin* rather than accepted as a string, so a path or a trailing slash cannot
produce `https://api.example.com//auth/login`, and plaintext is refused outside
loopback. Absent is a legitimate value and produces `undefined` rather than a guessed
default (Cloud 0.2; `docs/cloud/API-STAGING.md` §7).

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
| `API_HOST` / `API_PORT` | ✓ | — | — | ✓ (`API_HOST` only) | — |
| `PORT` | — | — | — | injected by the platform | — |
| `API_TRUST_PROXY` | — | — | — | ✓ | — |
| `CORS_ALLOWED_ORIGINS` | — | — | — | ✓ | — |
| `WORKER_HEARTBEAT_INTERVAL_MS` | ✓ | — | — | — | — |
| `DATABASE_SSL_ROOT_CERT` | staging only | ✓ (`staging` env) | — | ✓ | ✓ |

`PORT` is the container platform's own name for the port to listen on. `API_PORT` falls
back to it when unset, and `API_PORT` wins when both are present — so a deployment can
always override the platform and neither name is silently ignored. **`API_PORT` is
deliberately not set on the API host:** an explicit value would win over the injected
`PORT` and leave the service listening where nothing routes. `API_HOST` gets no such
fallback, because it defaults to loopback and a container must bind `0.0.0.0`
deliberately.

`API_TRUST_PROXY` is the proxy trust boundary, and it is a security setting rather than
plumbing: it decides whether `x-forwarded-for` may be believed, and therefore what
`request.ip` is — the login rate-limit key and the address written to every
`sessions.ip` row. It defaults to `false` (the socket peer, unforgeable). It accepts a
list of addresses, CIDR blocks or Fastify's named groups, and **refuses both `true` and
a hop count** — the latter because `fastify@5` enforces nothing for a number, so a hop
count would read as configured and behave as `false`
(`docs/cloud/API-STAGING.md` §5).

`CORS_ALLOWED_ORIGINS` is an exact-match allowlist of browser origins allowed to make
credentialed cross-origin requests. Empty is the default and means no grant at all. `*`
cannot be configured, and plaintext is refused outside loopback: a wildcard origin
cannot carry credentials, and a cookie-session API that emits one has stopped having an
origin policy (`docs/cloud/API-STAGING.md` §7).

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
holds. Never set on Vercel: the web deployment does not talk to the database at all, and
after Cloud 0.2 it still does not — the browser reaches the API, and the API reaches the
database.

`DATABASE_MAX_CONNECTIONS` is **5** on the staging API host, down from the default 10.
One instance behind Supavisor on a shared free-tier database: a large client-side pool
multiplied by instances is how a shared staging database runs out of connections
(`docs/cloud/API-STAGING.md` §4).

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

The staging API host holds a **dedicated** `AUTH_SESSION_SECRET`, generated for that
service and used nowhere else. It is not the local development value, it is not in
source control, and it is not recorded in any document. `AUTH_COOKIE_SECURE` and
`AUTH_COOKIE_SAME_SITE` are not set there: `NODE_ENV=production` already means Secure
`__Host-` cookies, and `lax` is the default and the correct value for the sibling
subdomain topology (`docs/cloud/API-STAGING.md` §7).

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
