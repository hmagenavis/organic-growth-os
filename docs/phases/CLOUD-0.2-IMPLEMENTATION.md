# CLOUD-0.2 — Fastify API staging runtime (implementation record)

Status: **BLOCKED at the human boundary** — the repository half is complete and green;
creating the Render service, attaching the domain and entering the secrets are steps
only the account owner can take (§9).
Architecture: `docs/cloud/API-STAGING.md`.

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

_To be completed once the service exists._
