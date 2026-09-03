# CLOUD-0.2 — Fastify API staging runtime (implementation record)

Status: **DEPLOYED on Render's free instance; unauthenticated verification complete;
authenticated E2E pending the staging identity (2026-09-03).** The account owner chose
not to pay for staging hosting yet, so the service runs on the free instance type with
the consequences accounted for in §10; moving to a paid always-on instance is a
one-word change in `render.yaml`. Live results are in §10.
Architecture: `docs/cloud/API-STAGING.md`.

**What is proven and what is not, stated plainly.** Everything about the deployed
network path is now measured rather than assumed: TLS at the origin, `verify-full` TLS
to Supabase from the deployed process, the CORS grant and refusal against real origins,
CSRF against the production cookie profile, graceful shutdown under a real rolling
deploy, no secret in the logs, and the proxy trust boundary — including against a
forged header. Two things remain: an authenticated end-to-end run, which needs a
staging identity only the account owner can provision (§9, §10.5); and real browser
cookie behaviour, which needs web and API on one registrable domain (§3).

Cloud 0.1 put the web app on Vercel and the database on Supabase. Cloud 0.2A proved the
API works against that database from the operator's own machine. What was left was the
part neither of them touched: **giving the API a home, and dealing with what changes
the moment something sits in front of it.**

Almost nothing in this phase is about hosting. Three things become security decisions
the instant the API stops being reached on `127.0.0.1` — who the process believes about
`x-forwarded-for`, which browser origins may read its responses, and whether a browser
can hold a session against it at all — and those are what the work is.

---

## 1. What was implemented

| Area | Where |
|---|---|
| Container image | `apps/api/Dockerfile`, `.dockerignore` |
| Proxy trust boundary | `packages/config/src/http.ts` (`parseTrustProxy`) |
| Origin parsing, shared by server and client schemas | `packages/config/src/origins.ts` |
| `API_TRUST_PROXY`, `CORS_ALLOWED_ORIGINS`, `PORT` fallback | `packages/config/src/server.ts` |
| `NEXT_PUBLIC_API_BASE_URL` | `packages/config/src/client.ts` |
| CORS policy | `apps/api/src/http/cors.ts` |
| `buildApp` wiring for both | `apps/api/src/app.ts` |
| Bounded graceful shutdown, edge configuration logged at startup | `apps/api/src/index.ts` |
| Service definition | `render.yaml` |
| Container verification in CI | `.github/workflows/api-container.yml` |

No migration. No new runtime dependency. No change to authentication, authorization,
tenancy or any route's behaviour.

## 2. The finding that changed the design

**`fastify@5.12.1` makes a numeric `trustProxy` trust nothing.**

```js
// fastify/lib/request.js — getTrustProxyFn
if (typeof tp === 'number') {
  // Hop-count-only trust cannot validate the immediate peer. Fail closed so
  // direct clients cannot spoof X-Forwarded-* values by supplying enough hops.
  return function () { return false }
}
```

The obvious configuration for a service behind exactly one load balancer is
`trustProxy: 1`. It was written, and the test that asserted `request.ip` came from
`x-forwarded-for` failed — Fastify had returned the socket peer. Fastify's reasoning is
right, and it is the reason the hop count is now **refused at startup** rather than
merely unsupported: `API_TRUST_PROXY=1` would read as configured, behave as `false`,
and leave `request.ip` pointing at the platform's load balancer — which is to say every
login attempt in the world counted against one rate-limit bucket, and every
`sessions.ip` row recording the same address.

What replaces it is the only form Fastify actually enforces: **name the peer.**
`API_TRUST_PROXY=uniquelocal` believes `x-forwarded-for` only when the socket peer is
in private address space, which on a managed container platform is the platform's own
load balancer and which no internet client can be. `apps/api/src/http/trust-proxy.test.ts`
pins the behaviour at each boundary, including that a client forging its own
`x-forwarded-for` entry does not move the reported address.

`true` is refused for the more familiar reason: the service's URL is reachable by the
whole internet, so it would let any caller choose its own `request.ip`.

## 3. The cookie spike, and what it ruled out

This was the decision the phase turned on, and it has one hard constraint that is not
negotiable:

- Session and CSRF cookies carry the `__Host-` prefix, which forbids a `Domain`
  attribute. They are host-only.
- `AuthCookiePolicy.sameSite` accepts `'lax' | 'strict'` and **has no `'none'`**. That
  is deliberate.

`*.vercel.app` and `*.onrender.com` are both on the Public Suffix List, so they are
different *sites*, and a `SameSite=Lax` cookie is not sent cross-site. A browser on one
therefore **cannot** hold a session against the other. No CORS configuration changes
that, and every way of making it work — `SameSite=None`, dropping `HttpOnly`, moving the
token to `localStorage`, substituting a JWT — is a weakening the brief explicitly
forbids and the architecture exists to avoid.

Two arrangements preserve the design intact:

| | Cookies | CORS | `request.ip` | Needs |
|---|---|---|---|---|
| **A. Sibling subdomains** — `app.<domain>` / `api.<domain>` | unchanged; same-site, so Lax works | required, exact single origin | the real browser address | a registrable domain |
| **B. Same-origin proxy** — Vercel rewrites `/api/*` | unchanged; one origin, strongest story | none at all | **the Vercel egress address** | nothing |

**A was chosen.** B is tempting — it needs no domain and removes CORS from the picture
entirely — and it was rejected on one concrete consequence rather than on taste: the API
would see Vercel's egress address as the client for every request, so the per-source
login limiter would collapse into a single global bucket of 20 attempts per 15 minutes
for the entire internet. That is a self-inflicted denial of service *and* the loss of
per-attacker throttling, and restoring it means a proxy-authenticated client-IP header —
a shared secret and a second proxy implementation to get right. Cloud 0.2's own brief
says the single-instance in-memory limiter must "behave as designed"; B is the option
that stops it doing so.

B is recorded rather than discarded. If the project ever wants a single public origin,
that is the shape, and the client-IP problem is the first thing to solve.

## 4. CORS, and what it is not

`apps/api/src/http/cors.ts`, driven by `CORS_ALLOWED_ORIGINS`. Exact string match
against normalised origins, empty by default, `Vary: Origin` whenever a grant is
possible, credentials only alongside an exact origin, `*` impossible to configure.

Two behaviours are worth stating because they look like omissions and are not:

- **A preflight from an unlisted origin is refused (403); an actual request from one is
  allowed to run and simply receives no `Access-Control-Allow-Origin`.** That is how a
  browser is told no. Failing the request outright would break any same-origin proxy
  arrangement, where a browser's own `Origin` header arrives looking cross-origin, and
  it would buy nothing: a cross-site request carries no session cookie, and a
  state-changing one is refused by CSRF.
- **CORS is not the CSRF control.** It says who may *read* a response. What stops a
  hostile page acting as the user is the signed, session-bound double-submit token, and
  `SameSite` is defence in depth. Neither was changed by this phase.

## 5. Container

`apps/api/Dockerfile`, built from the repository root, Debian-based because
`@node-rs/argon2` ships prebuilt per platform and glibc is the build CI exercises — a
musl image would silently swap the password-hashing implementation for an untested one.

Properties the image is responsible for, each asserted in CI rather than asserted in a
comment:

- runs as `node`, not root;
- contains no `.env` file of any kind, and no connection string in its logs;
- carries the published Supabase root CA, so the database connection is `verify-full`;
- serves `/health` **without a database**, and answers `/health/ready` with 503 and no
  diagnostic detail when the database is unreachable;
- drains on SIGTERM and exits 0, rather than being killed at the platform's deadline.

`API_PORT` is deliberately **not** set in the image. The platform injects `PORT`, and
`packages/config/src/server.ts` falls back to it; an image-level `API_PORT` would win
over the injected value and leave the service listening where nothing routes. `API_HOST`
*is* set, because the schema defaults to loopback and a container must bind every
interface on purpose.

`.dockerignore` excludes `.env*`, which is what keeps `.env.api.local` — a real staging
database credential and the CSRF signing secret — out of the build context.

## 6. Pooling and migrations, unchanged and deliberately so

`DATABASE_MAX_CONNECTIONS=5` for one instance behind Supavisor in session mode, down
from the default 10. Statement and idle-in-transaction timeouts are untouched and are
still passed as connection options rather than `SET` statements. Tenant context remains
transaction-local: `BEGIN` → `set_config(..., true)` → work → `COMMIT`/`ROLLBACK`, with
the third argument being what makes the context die with the transaction rather than
leak to the next borrower of the connection.

**The API does not migrate and cannot.** No startup migration, no entrypoint script, no
migrator credential in the service. Schema changes remain the `workflow_dispatch`-only
`staging-database` workflow. A deploy is build → start → health → readiness → smoke
test, and there is no migrate step in it.

## 7. Rate limiting: the limitation, stated rather than implied

The login limiter is still in-memory and per-process. That is correct **only because
there is exactly one instance**, which `render.yaml` pins with `numInstances: 1` and
which the service warns about at startup in production.

- One instance → 20 attempts per source address and 10 failed attempts per account, per
  15 minutes, exactly as designed.
- More than one → each instance counts a fraction of the attempts against its own store,
  and distributed rate limiting is **not** guaranteed.

Do not enable autoscaling and do not raise `numInstances` before a shared store exists.
Redis is explicitly out of scope for this phase.

## 8. Verification

### Repository

| Gate | Where | Result |
|---|---|---|
| `pnpm format:check` | local | pass |
| `pnpm lint` | local | pass |
| `pnpm typecheck` | local | pass |
| `pnpm test` (unit) | local | pass |
| `pnpm build` | local | pass |
| CI: format, lint, typecheck, unit, **integration on real PostgreSQL**, build, `pnpm audit --audit-level critical` | run `33676303739` | **green** |
| API container: build, non-root, no `.env` in the image, root CA present, liveness without a database, readiness failing safely, CORS grant and refusal, no secret in the logs, SIGTERM draining | run `33676303827` | **green** |

The container workflow's assertions are the deployment-readiness gate, and they are
assertions rather than a smoke test that would pass on a broken image: the readiness
step requires a **503** whose body mentions no host, port, role or driver error; the
CORS step requires a 403 preflight from an unlisted origin and no wildcard anywhere;
the SIGTERM step requires exit code 0 in under 20 seconds with `shutdown complete` in
the log, so a container that ignored the signal and was killed at the deadline (137)
fails.

### One thing the container workflow found

The first run failed at `pnpm install --prod`:
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`. Switching an existing install to `--prod`
rebuilds the modules directory and pnpm refuses to do that unattended. `CI=true` is set
on the build stage only, so the flag does not travel into the runtime image. Trivial,
and exactly the class of thing that is better found here than on first deploy.

### Deployment

Pending the service (§9). The tool is `pnpm verify:e2e --api https://api.<domain>
--email <address>`, built and itself tested in Cloud 0.2A: it drives the deployed API
the way a browser does, with real sockets, real cookies and a real CSRF header, and its
integration suite requires it to **refuse to report success** when the password is wrong
or nothing is listening.

## 9. What only a human can do

Recorded here because the phase stops at exactly these steps, per the brief's human
action boundary. None of them can be scripted, and none of their values may pass
through a chat message.

1. **A registrable domain**, with `app.` pointing at Vercel and `api.` at Render. This
   is not cosmetic — §3 is why.
2. **A Render account and the service**, created from `render.yaml`. Billing approval
   for one Starter instance; the free instance type spins down and would break both the
   readiness contract and the single-always-on-instance property §7 depends on.
3. **Three values entered in Render**, by name: `DATABASE_URL`, `AUTH_SESSION_SECRET`
   and `CORS_ALLOWED_ORIGINS`. Everything else in the service is a literal in
   `render.yaml` and therefore reviewable in a diff. The session secret is generated for
   this service and used nowhere else; it appears in no document and no commit.
4. **`NEXT_PUBLIC_API_BASE_URL` on Vercel.**
5. **`pnpm provision:organization`**, to create the first staging organization and its
   `agency_admin`. Staging currently holds zero organizations, zero users and zero
   memberships, so there is nothing to log in as. The command reads the password from a
   terminal with the echo off, because a first-administrator credential must not come
   from argv or the environment.

## 10. Results

### Deployment (2026-09-03, Render free instance, Frankfurt)

| Item | Value |
|---|---|
| Service | `organic-os-api-staging`, `srv-daco26qfngtc73e5p9pg`, Blueprint-managed |
| Origin | `https://organic-os-api-staging.onrender.com` |
| Branch deployed | `cloud/0.2-api-staging-runtime` @ `807e54d`, via `autoDeployTrigger: checksPass` |
| TLS at the origin | Google Trust Services WE1, `CN=onrender.com`, verified (`curl` `ssl_verify_result=0`); plaintext `http://` → 301 to `https://` |
| Edge in front of the origin | **Cloudflare**, then Render's own proxy on the container host (§10.2) |

Every check below ran against that origin from outside, and the log lines it produced
were read back in Render's log stream.

| Check | Result |
|---|---|
| `GET /health` | 200, `{"status":"ok","service":"api","version":"0.2.0-staging"}` |
| `GET /health/ready` | 200 `ready` — a real `SELECT 1` through the pool over `verify-full` TLS to Supabase, because `tlsOptionsFor` refuses a non-local connection with anything less |
| `x-content-type-options` | `nosniff` on every response |
| Unauthenticated `/auth/me`, `/auth/organizations`, `/organizations/:id/clients`, `/organizations/:id/members` | 401, problem+json, no internals |
| Malformed organization id | 401, no internals |
| Path traversal (`/organizations/../../etc/passwd`) | normalised and 404, problem+json |
| Unknown route | 404, `application/problem+json`, request id, no stack |
| `POST /auth/login` without CSRF | 403 `csrf-token-invalid`; log verdict `missing_cookie_token` |
| `GET /auth/csrf` | 200, `__Host-organic-os-csrf` cookie set — the **production** cookie profile is live |
| Login with a mismatched CSRF token | 403; log verdict `token_mismatch` |
| Login with a valid CSRF token and wrong credentials | 401 `invalid-credentials`; log `reason: unknown_user`, no address, no password |
| CORS, allowed origin, actual request | `access-control-allow-origin: https://organic-growth-os-web.vercel.app`, `access-control-allow-credentials: true`, `vary: origin` |
| CORS, allowed origin, preflight | 204 with methods `GET, HEAD, POST, PATCH, OPTIONS`, headers `content-type, accept, x-csrf-token`, max-age 600 |
| CORS, unlisted origin, preflight | 403 |
| CORS, unlisted origin, actual request | 200 with **no** `access-control-allow-origin` |
| SIGTERM during a rolling deploy | `shutdown requested` → `shutdown complete` in 2 ms, exit clean, no SIGKILL |
| Startup with `AUTH_SESSION_SECRET` absent (first deploy) | refused to start: `AUTH_SESSION_SECRET (invalid_type)` — the variable name only, no value, no environment dump |
| Logs | no password, no connection string, no cookie, no token, no secret name with a value |
| `request.ip` for a request from a known address | **the real address**, `192.115.79.114` |
| `request.ip` for the same request with a forged `x-forwarded-for: 1.2.3.4, 10.0.0.9, 172.68.1.1` | **still the real address** |

### 10.1 The first deploy failed, correctly

Both `sync: false` values entered on Render's Blueprint screen were silently dropped —
the service came up with ten variables, not twelve. The process refused to start and
logged exactly one thing: `AUTH_SESSION_SECRET (invalid_type)`. That is `createAuthConfig`
failing closed, naming the variable and nothing else. The values were entered again in
the service's Environment tab, and the second paste of `DATABASE_URL` brought three
lines of the local `.env` file with it into a textarea that accepts multi-line input
silently; it was trimmed to the single `postgres://…/postgres` line in-page before
saving. A URL with a stray `DATABASE_MAX_CONNECTIONS=5` on its second line would have
been the next startup failure, and it too would have named only the variable.

### 10.2 The trust boundary took two measured corrections

Recorded in full in `docs/cloud/API-STAGING.md` §5; the short form:

1. `uniquelocal` alone → every external request logged `ip: 127.0.0.1`. Render's proxy
   is on the container host; only its health checker (`10.231.x.x`) is private-range.
2. `loopback,uniquelocal` → the same request logged `ip: 162.158.94.136`, a Cloudflare
   edge. `*.onrender.com` is Cloudflare-fronted.
3. `loopback,uniquelocal,<Cloudflare ranges>` → `ip: 192.115.79.114`, the real client,
   and unchanged under a forged header.

Neither of the first two would have been caught without the `ip` field this phase added
to the request log. Both are the exact failure §7 describes — every client in one
rate-limit bucket — and both looked like a correctly configured service from the
outside.

### 10.3 Render's edge blocks some requests before they reach the API

A path containing a SQL-injection-shaped segment (`' OR 1=1--`) returned a Render/Cloudflare
HTML "Blocked" page (403), never reaching Fastify. This is defence in depth the platform
supplies and the application did not ask for. It is recorded so that a 403 with an HTML
body is not mistaken for an API response, and so nobody relies on it: the API's own
validation is what is tested.

### 10.4 The web production alias is public

`https://organic-growth-os-web.vercel.app` serves the application with no SSO in front
of it, while the team-scoped deployment URL redirects to Vercel's SSO. Vercel's
"Standard" deployment protection covers preview and deployment URLs, not the production
alias. `docs/cloud/VERCEL-STAGING.md` claimed the staging build was not world-readable;
that claim was true of the URL that was checked and false of the production alias, and
is corrected there. The exposure is a Phase 0.1 static shell.

### 10.5 Not yet done

- **Authenticated E2E.** Staging still holds zero organizations and zero users;
  `pnpm provision:organization` reads the first administrator's password from a
  terminal and is therefore the account owner's to run. Once it has run,
  `pnpm verify:e2e --api https://organic-os-api-staging.onrender.com --email <address>`
  is the tool, and it too prompts for the password.
- **Browser cookie behaviour** stays unverified until web and API share a registrable
  domain (§3). Everything else in the topology is now measured rather than assumed.

### If the deployment resumes on a free instance

Render's `Free` instance type spins down after ~15 minutes of inactivity and takes
~50 seconds to wake. Two consequences, and only one of them is a real loss:

- **The login rate limiter is unaffected.** This looked like the problem and is not:
  the limiter's window is 15 minutes, the same order as the spin-down threshold, so an
  attacker who waits out a spin-down has waited out the window anyway. A spin-down
  hands them nothing they did not already have.
- **Browser cookie behaviour stays unverified**, because a free instance is still
  reached on a platform hostname unless a custom domain is attached. `pnpm verify:e2e`
  would still pass in full — it carries its own cookie jar and does not enforce
  SameSite — so login, session, CSRF and the Phase 0.4 authorization rules would all be
  proven against a deployed service. The one thing that would remain proven only on
  paper is §3, and §3 is the part that matters most.

A free instance is therefore a real intermediate step rather than a pretend one, as
long as that last sentence is not forgotten.
