# API-STAGING.md

# Where `apps/api` runs, and what that changes

Status: **repository ready; service not yet created** — see §12.
Phase record: `docs/phases/CLOUD-0.2-IMPLEMENTATION.md`.

Cloud 0.1 put the web app on Vercel and the database on Supabase and deliberately left
the API without a home. Cloud 0.2 gives it one. Nothing about how the API works
changes; what changes is that there is now a TLS terminator in front of it and a
browser origin beside it, and both of those are security settings rather than
plumbing.

---

## 1. Topology

```
Browser
  │  https://app.<domain>                      __Host- session + CSRF cookies,
  ▼                                            host-only, HttpOnly, Secure, Lax
Vercel — apps/web (Next.js)
  │
  │  fetch(https://api.<domain>/…, {credentials: 'include'})
  │  same-site: one registrable domain, so Lax cookies are sent
  ▼
Render — apps/api (Fastify, Docker, one instance, Frankfurt)
  │  pg.Pool, TLS verify-full against the pinned Supabase root
  ▼
Supavisor (session mode, :5432)
  ▼
Supabase PostgreSQL 17 — organic_os_runtime, FORCE ROW LEVEL SECURITY
```

`apps/worker` is not deployed and is not part of this phase (§11).

## 2. The hosting decision

**Render, Frankfurt, Docker runtime, one Starter instance.**

The requirement set is short and none of it is negotiable: a long-lived Node process,
a connection pool that outlives a request, Argon2id at OWASP cost, HTTPS, secrets that
are not in the image, health and readiness endpoints, deployment from GitHub, and
predictable restart behaviour. `docs/cloud/CLOUD-ARCHITECTURE.md` §4 already ruled out
a serverless runtime for this service and that is not reopened here.

Among container platforms the differences that decided it:

| | Render | Railway | Fly.io | Vercel Functions |
|---|---|---|---|---|
| Region matching Supabase `eu-central-1` | **Frankfurt** | Amsterdam | Frankfurt | n/a |
| Dockerfile + GitHub auto-deploy, no extra CI wiring | yes | yes | needs `flyctl` + an Action | n/a |
| Deploy gated on a health check | **yes, first-class** | `healthcheckPath` | via checks | n/a |
| Always-on single instance | yes (paid) | yes | must pin `auto_stop_machines` | no |
| Long-lived pool / native argon2 | yes | yes | yes | **no** |

Frankfurt is the tiebreaker and it is not cosmetic: every authorized request is a
transaction, so the round trip to the database is paid several times per request.

**Cost posture.** One service, one instance, no replicas, no load balancer, no
Kubernetes, no IaC beyond the single `render.yaml`, no Redis, no second region.
Render's free instance type is not usable here — it spins down after inactivity, which
would break both the readiness contract and the single-always-on-instance property the
in-memory rate limiter depends on (§8).

## 3. The image

`apps/api/Dockerfile`, built from the repository root. Four properties it exists to
guarantee:

- **No secret is in it.** No `ARG` carries one, `.dockerignore` excludes `.env*`, and
  CI asserts the outcome rather than trusting the file (`api-container.yml`).
- **No migration runs in it.** There is no entrypoint script. The image holds the
  runtime credential only, and could not migrate if it tried (§6).
- **It runs as `node`, not root**, and writes nothing.
- **It is PID 1 and handles SIGTERM itself.** `CMD` is exec form, and `src/index.ts`
  drains the server and then the pool, bounded by its own 20-second timer so a stuck
  request cannot turn a rolling deploy into a SIGKILL.

Debian rather than Alpine, because `@node-rs/argon2` ships prebuilt binaries per
platform and the glibc build is the one CI exercises. A musl image would silently swap
the password-hashing implementation for one nothing has tested.

`certs/` is included deliberately: it holds the published Supabase root CA. A root
certificate is public by construction — a variable, never a secret.

**`API_PORT` is not set in the image.** Render injects `PORT` and routes to it;
`packages/config/src/server.ts` falls back to `PORT` when `API_PORT` is absent, and an
image-level `API_PORT` would win over it and leave the service listening where nothing
routes. `API_HOST=0.0.0.0` *is* set, because the schema defaults to loopback and a
container has to bind every interface on purpose rather than by inheriting a variable.

## 4. Database connection and pooling

The service holds one credential: `DATABASE_URL`, carrying `organic_os_runtime`. It
never receives `DATABASE_MIGRATOR_URL`, `DATABASE_PROVISIONER_URL`,
`DATABASE_ADMIN_URL`, any role password, or a Supabase `service_role` key. That is not
a policy about what handlers do; it is the reason a serving process *cannot* reshape
the schema or create a tenant.

- **Supavisor session mode, port 5432** — not transaction mode (6543). The API keeps
  its own `pg.Pool`; session mode avoids pooling a pool
  (`docs/cloud/SUPABASE-STAGING.md` §3).
- **`DATABASE_MAX_CONNECTIONS=5`**, down from the default 10. One instance, a shared
  free-tier database, and a pooler in front: a large client-side pool multiplied by
  instances is exactly how a shared staging database runs out of connections. Five is
  ample for a console with no traffic and leaves headroom for the operator CLIs.
- **`DATABASE_STATEMENT_TIMEOUT_MS=30000`** and **`DATABASE_IDLE_TX_TIMEOUT_MS=15000`**
  are unchanged, and are passed as connection options rather than issued as `SET`
  statements — session-level state on a pooled connection is the pattern tenant context
  must never use.
- **Tenant context stays transaction-local.** `withAuthorizedOrganization` opens a
  transaction, calls `set_config(..., true)`, does the work and commits or rolls back.
  Nothing about this deployment touches that, and nothing may: `set_config`'s third
  argument being `true` is what makes the context die with the transaction rather than
  leaking to the next borrower of the connection.

**TLS is `verify-full` or nothing.** `packages/database/src/tls.ts` refuses a non-local
connection that has no configured root, rather than downgrading it to plaintext.
`rejectUnauthorized: false` appears nowhere and must never be added.
`DATABASE_SSL_ROOT_CERT` points at the copy of the root inside the image.

## 5. `trustProxy` — the trust boundary

Phase 0.3 shipped `trustProxy: false` because nothing was in front of the process.
Render terminates TLS at its own edge, so this has to be stated.

The setting is `API_TRUST_PROXY=loopback,uniquelocal`: believe `x-forwarded-for` only
when the socket peer is loopback or in private address space — the two places Render's
own proxies live, and two places no internet client can be. Walking the chain from the
socket inwards then stops at the first public address, which is the browser as Render's
edge observed it.

**That value was measured, not assumed, and the first guess was wrong.** The service
was deployed with `uniquelocal` alone, on the reasoning that a platform load balancer
sits in private address space. The `request completed` log then showed every external
request with `ip: 127.0.0.1` and every health check with `ip: 10.231.26.95`: Render
hands external traffic to the container through a proxy on the *same host*, so the
peer is loopback, while its health checker is the private-range one. With
`uniquelocal` alone the boundary trusted the health checker and not the traffic, and
every browser collapsed to one rate-limit bucket — exactly the failure §5 exists to
prevent, in a variant nobody had predicted. Adding `loopback` fixed it, and
`apps/api/src/http/trust-proxy.test.ts` now pins both peers. The log field that made
this visible is the one this section asks for.

Two forms are **refused at startup**, and the refusals are the substance of
`parseTrustProxy`:

- **`true`** — it tells Fastify to believe the header from anyone. The service's URL is
  reachable by the whole internet, so that would make `request.ip` — the login
  rate-limit key and the address written to every `sessions.ip` — an attacker-supplied
  string.
- **A hop count.** This one is not obvious and matters more. `fastify@5.12.1` maps a
  numeric `trustProxy` to a function that trusts *nothing*
  (`lib/request.js`, `getTrustProxyFn`), on the correct reasoning that a hop count
  cannot validate the immediate peer. So `API_TRUST_PROXY=1` would read as configured,
  behave as `false`, and quietly leave `request.ip` pointing at the load balancer with
  every login in the world sharing one rate-limit bucket. Refusing it turns a silent
  no-op into a startup failure.

The resolved address is included in the `request completed` log line. A security log
that omitted it could not be used to check that the boundary in force is the one that
was intended.

**Known limit.** The boundary is sound while the peer cannot be an arbitrary internet
host — which holds on Render, where the process is only reachable through the platform
edge. It is verified live rather than assumed (§10).

## 6. Migrations

The API does not migrate, and cannot. There is no startup migration, no auto-migrate
path, and no migrator credential in the service. Schema changes remain the manual,
`workflow_dispatch`-only `staging-database` workflow bound to the `staging` GitHub
Environment (ADR-0003, `docs/cloud/CLOUD-ARCHITECTURE.md` §5).

If the schema is behind, readiness stays green (the probe is `SELECT 1`) and the
affected routes fail. That is the intended shape: the application reports a problem
rather than repairing the database underneath itself.

## 7. Cookies, CORS and CSRF

### The constraint, stated plainly

Session and CSRF cookies carry the `__Host-` prefix in production, which forbids a
`Domain` attribute — they are host-only. `AuthCookiePolicy.sameSite` accepts
`'lax' | 'strict'` and deliberately has no `'none'`. Adding one would weaken the CSRF
posture the design chose, and is not on the table.

Together those mean a browser on `*.vercel.app` **cannot** hold a session against an
API on `*.onrender.com`. Both are on the Public Suffix List, so they are different
sites, and a `SameSite=Lax` cookie is not sent cross-site. This is not a configuration
problem to work around; it is the design working.

### The arrangement chosen: sibling subdomains

`app.<domain>` on Vercel, `api.<domain>` on Render, on one registrable domain.

| Property | Effect |
|---|---|
| `__Host-` prefix | unchanged. The cookie is host-only to `api.<domain>`, which is where it is needed |
| `Secure`, `HttpOnly` | unchanged. No session value is reachable from JavaScript |
| `SameSite=Lax` | unchanged, and it works: one registrable domain means same-site, so the cookie is sent on a credentialed `fetch` from `app.` to `api.` |
| CSRF | unchanged. Signed double-submit, bound to the session id |
| CORS | required, and configured as an exact single-origin allowlist |
| `request.ip` | the real browser address. The login rate limiter works as designed |

### The alternative that was evaluated and not chosen

A same-origin proxy — Vercel rewriting `/api/*` to Render — needs no domain and has an
even simpler cookie story (one origin, no CORS at all). It was rejected on one
concrete consequence: the API would then see Vercel's egress address as the client for
every request, so the per-source login limiter would collapse into a single global
bucket of 20 attempts per 15 minutes for the entire internet — a self-inflicted denial
of service, and no per-attacker throttling. Restoring it would mean a
proxy-authenticated client-IP header, which is a shared secret and a second proxy
implementation to get right. The subdomain arrangement preserves the existing
behaviour without either.

It is recorded rather than discarded: if the project ever wants a single public origin,
that is the shape, and the client-IP problem is the thing to solve first.

### CORS as implemented

`apps/api/src/http/cors.ts`, configured by `CORS_ALLOWED_ORIGINS`.

- **Exact string match** against normalised origins. No prefix, suffix, scheme or port
  fuzziness — the tests pin `https://app.example.com.evil.test` and
  `http://app.example.com` as non-matches.
- **`*` cannot be configured.** `parseAllowedOrigins` refuses it, and refuses plaintext
  for anything but loopback. A wildcard cannot carry credentials, and a cookie-session
  API that emits one has stopped having an origin policy.
- **Credentials are granted only alongside an exact origin.**
- **Empty is the default**, and it is the absence of a grant rather than a permissive
  fallback.
- **A preflight from an unlisted origin is refused with 403.** An *actual* request from
  one is allowed to run but receives no `Access-Control-Allow-Origin`, which is how a
  browser is told no. Failing it outright would break any same-origin proxy arrangement,
  where a browser's own `Origin` header arrives looking cross-origin, and it would buy
  nothing: a cross-site request carries no session cookie, and a state-changing one is
  refused by CSRF.
- `Vary: Origin` whenever a grant is possible, so no shared cache can serve one
  origin's response to another.

**CORS is not the CSRF control and never was.** What stops a hostile page acting as the
user is the signed, session-bound CSRF token; `SameSite` is defence in depth. Both are
verified against the deployed topology (§10).

## 8. Login rate limiting

Still single-process, still in memory (`packages/auth/src/rate-limit/memory.ts`), and
that is acceptable for Phase 0 **because there is exactly one instance**.
`render.yaml` pins `numInstances: 1` for that reason, and the service logs a warning at
startup in production saying so.

The property and its limit, stated once:

- **One instance → the limiter behaves exactly as designed.** 20 attempts per source
  address and 10 failed attempts per account, per 15 minutes.
- **More than one instance → distributed rate limiting is not guaranteed.** Each
  instance would count a fraction of the attempts against its own store. Do not enable
  autoscaling, and do not raise `numInstances`, until a shared store exists. Redis is
  explicitly out of scope for Cloud 0.2.

## 9. Deployment pipeline

```
push to main
  → GitHub CI (format, lint, typecheck, unit, integration on real PostgreSQL, build, audit)
  → GitHub "API container" workflow (build the image; liveness, readiness, CORS,
     SIGTERM and no-secrets assertions against the running container)
  → Render builds the same Dockerfile and starts the service
  → Render gates promotion on GET /health/ready
  → operator runs `pnpm verify:e2e --api https://api.<domain> --email <address>`
```

Note what is **not** in it: there is no migrate step between build and start. A deploy
builds, starts, proves health and readiness, and is then smoke-tested. Schema changes
are a separate, gated, manual operation.

Pull-request previews are disabled on the Render service (`previewsEnabled: false`).
A preview would need this service's environment to be useful, and that environment
holds the runtime database credential and the session secret.

## 10. Verification

CI proves the *logic* against a database it builds and destroys. This document's
concern is the *deployment*, and `pnpm verify:e2e --api <origin>` is the tool for it —
it drives the deployed API the way a browser does, with real sockets, real cookies and
a real CSRF header, and it is itself tested in CI
(`apps/api/src/cli/verification.int.test.ts`). Results in
`docs/phases/CLOUD-0.2-IMPLEMENTATION.md`.

## 11. What this phase does not do

- **No worker.** `apps/worker` is not deployed, and no Redis, BullMQ, crawler or
  Playwright job runs anywhere. Cloud 0.3.
- **No production.** Staging only: no production domain, no production Supabase, no
  reuse of production credentials, no public launch.
- **No dashboard.** `apps/web` gains only what it needs to know where the API is.
- **No observability vendor.** The platform's own log stream, and the existing pino
  redaction, are what exist.
- **No object storage**, no LLM runtime, no Google or WordPress integration.

## 12. Related documents

- `docs/cloud/CLOUD-ARCHITECTURE.md` — the whole cloud picture and why the API is not
  serverless
- `docs/cloud/SUPABASE-STAGING.md` — roles, privileges, connection modes
- `docs/cloud/VERCEL-STAGING.md` — the web deployment
- `docs/cloud/ENVIRONMENT-MATRIX.md` — every variable, its class, and where it may live
- `docs/phases/CLOUD-0.2-IMPLEMENTATION.md` — what was done, verified and left open
