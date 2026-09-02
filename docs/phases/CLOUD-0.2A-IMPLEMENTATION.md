# CLOUD-0.2A — The API against managed staging, verified end to end (implementation record)

Status: **READY** — the infrastructure half is verified live against Supabase staging;
the login half needs one operator command that only a human can run (§5)
Scope source: the end-to-end goal agreed after Phase 0.4.2B2 merged

Cloud 0.1 left one hole in the picture:

```
Browser  →  Vercel (apps/web)  ✅
                                  ✗   no runtime for apps/api
            Supabase PostgreSQL ✅
            GitHub CI           ✅
```

This sub-phase closes it in the cheapest order. **0.2A runs `apps/api` on the
operator's own machine against the managed staging database**, which proves everything
about the *application* — a real pooled connection over verified TLS, a real login, a
real session, real CSRF, and the Phase 0.4 authorization rules applied to rows that
outlive the run. **0.2B** then moves that same process to a container host and connects
Vercel to it, which is a networking problem, not a product one.

Doing it this way means the bugs are found before any hosting bill, and one was found
immediately (§7.1).

---

## 1. What was implemented

| Area | Where |
|---|---|
| End-to-end verification checks, as a function | `apps/api/src/cli/verification.ts` |
| The command around them, which owns the password | `apps/api/src/cli/verify-e2e.ts` |
| The verification command, itself verified against real PostgreSQL | `apps/api/src/cli/verification.int.test.ts` |
| Operator scripts | `package.json` (`api:staging`, `verify:e2e`) |
| Terminal secret reader, exported for reuse | `packages/database/src/index.ts` |

No production code changed. No migration. No dependency added. The API, the database
package and the authorization package are exactly what merged with Phase 0.4.2B2.

---

## 2. What was verified live against Supabase staging

Run from this machine, against project `organic-growth-os-dev`
(`cxychekcsqcyzbgouviz`, `eu-central-1`, PostgreSQL 17.6), through the Supavisor
session pooler on `aws-0-eu-central-1.pooler.supabase.com:5432`.

| Check | Result |
|---|---|
| Runtime role connects with `verify-full` TLS | pass |
| `current_user` | `organic_os_runtime` |
| `rolsuper` / `rolbypassrls` / `rolcreatedb` / `rolcreaterole` | all `false` |
| Runtime role is refused `schema_migrations` | pass — `permission denied for table schema_migrations` |
| Rows visible with no tenant context set | `0` organizations, `0` users, `0` memberships |
| Migrations applied | 5 of 5 |
| Row Level Security on every tenant table | enabled |
| `apps/api` starts and serves `/health` | pass |
| `/health/ready` (a real query through the pool) | pass |
| Provisioner role reaches staging and refuses correctly | pass — `user_not_registered`, and it rolled back cleanly (still 0 organizations) |

The two negative results are the interesting ones. The runtime role being **denied**
`schema_migrations` and seeing **zero** rows without a tenant context are what the
privilege separation and Row Level Security are for; a run where those succeeded would
have been the failure.

---

## 3. The local environment

`.env.api.local` (gitignored, created by the operator; it holds the runtime database
credential and the CSRF signing secret):

```
NODE_ENV=development          # see below
LOG_LEVEL=info
SERVICE_VERSION=0.2.0-staging-local
API_HOST=127.0.0.1
API_PORT=3001

AUTH_SESSION_SECRET=<48 random bytes, base64url>
AUTH_COOKIE_SECURE=false
AUTH_COOKIE_SAME_SITE=lax

DATABASE_URL=postgres://organic_os_runtime.<ref>:<password>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres
DATABASE_MAX_CONNECTIONS=5
DATABASE_STATEMENT_TIMEOUT_MS=30000
DATABASE_IDLE_TX_TIMEOUT_MS=15000

DATABASE_SSL_ROOT_CERT=<absolute path>/certs/supabase-prod-ca-2021.crt
```

**`NODE_ENV` is `development`, and that is a correctness decision rather than laziness.**
Production refuses to start without Secure `__Host-` cookies, and a browser refuses a
`__Host-` cookie over plain HTTP — so a production profile on `http://127.0.0.1:3001`
could not hold a session at all. The development profile uses separately named
non-`__Host-` cookies for exactly this case (`packages/auth/src/config.ts`). Cloud 0.2B
runs behind HTTPS and flips to the production profile.

**Session mode (port 5432), not transaction mode (6543).** The API keeps its own
`pg.Pool`; session mode avoids pooling a pool. The `docs/cloud/SUPABASE-STAGING.md` §3
assignment table already said so, and this is the first time it has been exercised.

**Only the runtime credential is in this file.** The migration and provisioning
credentials are not, and the serving process never opens a connection with either.

---

## 4. The verification command

```bash
pnpm verify:e2e --email <address>
```

It drives a running API the way a browser does — real sockets, real cookies, real CSRF
header — and prints a pass/fail line per check. It answers a different question from
CI: CI proves the **logic** against a disposable database it built itself, and this
proves the **deployment**.

### What it checks

| Group | Checks |
|---|---|
| Health and the unauthenticated surface | `/health`; `/health/ready` (which is the pooled database connection); `/auth/me`, `/auth/organizations`, the client collection and the site collection all 401 without a session |
| CSRF and login | `/auth/csrf` issues a token and names its own header; login without the CSRF header is refused; login with a wrong password is refused; login succeeds; `/auth/me` returns the same user; `/auth/organizations` returns the membership |
| Members (0.4.2A) | the member list includes the caller; **self-demotion is refused** and changes nothing |
| Clients (0.4.2B1) | bounded page with no total count; a write without CSRF is refused; find-or-create; read; patch applies; an immutable field is a 400; an absent client and a foreign organization are both 404 |
| Sites (0.4.2B2) | a body that names an autopilot mode is refused; create; **`autopilotMode` is `review`**; listed under the parent client; patch applies and leaves the mode alone; autopilot / client-move / immutable / unknown patch fields all 400; a real site under the wrong parent client is 404; the base URL is unique across the organization (409); an unnormalizable URL is a 400 that does not echo the value; deletion and site-settings routes are 404 |
| Session lifecycle | logout; `/auth/me` afterwards is 401; **the old session cookie is dead server-side**, not merely cleared in the browser |

### It is idempotent

There is no client or site deletion in Phase 0.4.2, so the command reuses fixtures it
finds by name (`E2E verification`, `E2E verification (secondary)`,
`https://e2e-verification.organic-os.test`) rather than creating a set per run. A
second run changes nothing and still exercises every path — and the duplicate base URL
it would otherwise hit is turned into one of the checks.

The only member mutation it attempts is one the server **must refuse**. Verifying a
live environment is not a reason to mutate its memberships.

### The password never leaves the terminal

`verify-e2e.ts` reads it with the echo off through the same `readSecretFromTty` that
`provision:organization` uses, and passes it to `runVerification` as an argument. It is
never an argv value, never an environment variable, never logged. No check prints a
cookie value, a CSRF token or a session id.

### The command is itself tested

`apps/api/src/cli/verification.int.test.ts` runs `runVerification` against a real
Fastify server on a real TCP port, backed by real PostgreSQL, in CI. It requires the
full matrix to pass, requires a **second** run to pass (the idempotence property), and
requires the command to **refuse to report success** when the password is wrong or when
nothing is listening. A verification tool whose failure mode is "it silently checked
nothing" is worth more than a passing report.

---

## 5. The two commands only a human can run

Both need a terminal, and that is deliberate: a first-administrator password must not
come from argv or the environment (`packages/database/src/cli/secret-prompt.ts`).

**1. Provision the first organization and its `agency_admin`.** From the repository
root, in PowerShell. The password is read from the gitignored file rather than typed
into the shell, so it does not reach the command history:

```powershell
$pw = (Select-String -Path .env.staging.local -Pattern '^PROVISIONER_PASSWORD=(.+)$').Matches[0].Groups[1].Value
$env:DATABASE_PROVISIONER_URL = "postgres://organic_os_provisioner.cxychekcsqcyzbgouviz:$([uri]::EscapeDataString($pw))@aws-0-eu-central-1.pooler.supabase.com:5432/postgres"
$env:DATABASE_SSL_ROOT_CERT = (Resolve-Path "certs/supabase-prod-ca-2021.crt").Path
pnpm provision:organization --name "<display name>" --slug <url-slug> --email <address>
```

It prompts for a full name and then for the password twice, with the echo off, and
checks it against the platform password policy before anything is written. It is
idempotent on the slug.

**2. Verify.** With the API running (`pnpm build` then `pnpm api:staging`):

```bash
pnpm verify:e2e --email <address>
```

---

## 6. Cost

Nothing was spent and no account was created. The database is the existing Supabase
free project, the API runs on the operator's machine, and the verification tool is part
of this repository.

---

## 7. Findings

### 7.1 The operator scripts could not receive arguments

`pnpm provision:organization --name X` failed with
`Unexpected argument '--name'. This command does not take positional arguments`.

The root script ended with a trailing `--`, so pnpm's own argument forwarding produced
`tsx provision-organization.ts "--" "--name" "X" …` and the literal `--` arrived as a
positional argument that `parseArgs({ strict: true })` correctly refused.

This had never been exercised: Cloud 0.1 listed provisioning as not yet done, so the
command had never been run with arguments. The trailing `--` is removed from
`provision:organization` and was never added to `verify:e2e`. Both now forward
arguments correctly, confirmed against the live database.

**This is why 0.2A exists.** The bug is trivial and would have been the first thing a
human hit, on a paid host, at the least convenient moment.

### 7.2 The Supabase "RLS disabled" advisory does not apply here, and its fix would be an outage

Supabase's linter reports `schema_migrations`, `sessions` and `feature_flags` as
critical: *"fully exposed to the anon and authenticated roles… anyone with the anon key
can read or modify every row."*

Checked rather than assumed. `anon`, `authenticated`, `service_role` and `PUBLIC` hold
**no grant of any kind** on those three tables:

```sql
select c.relname, g.grantee, g.privilege_type
  from information_schema.role_table_grants g …
 where g.table_name in ('schema_migrations','sessions','feature_flags')
   and g.grantee in ('anon','authenticated','service_role','PUBLIC');
-- 0 rows
```

The advisory's premise is the Supabase Data API pattern, where tables are created by
`postgres` and inherit default privileges. Every table here is created by
`organic_os_migrator`, which has no `pg_default_acl` entry, so PostgREST would be
refused on privilege before Row Level Security was ever consulted — exactly as Cloud
0.1 §3 predicted.

**The suggested remediation must not be applied.** `ALTER TABLE sessions ENABLE ROW
LEVEL SECURITY` with no policy would deny the runtime role every row of the session
table, which is to say: nobody could log in. `sessions` is deliberately not
tenant-scoped — it is resolved by token hash before any organization is known — so
there is no tenant predicate to write a policy from.

Standing recommendation from Cloud 0.1, unchanged: disable the Data API on the project
as defence in depth. That removes the advisory by removing its subject.

### 7.3 The three tables without RLS are the three that should not have it

Restating it plainly because the advisory will keep appearing: `schema_migrations` is
schema metadata the runtime role cannot read at all, `sessions` is pre-tenant by
design, and `feature_flags` is platform configuration. Every table that holds tenant
data has `FORCE ROW LEVEL SECURITY`.

---

## 8. What 0.2B still has to decide

The one that shapes everything: **how the browser reaches the API**, because the
authentication design constrains it more than it looks.

* Session and CSRF cookies carry the `__Host-` prefix in production, which forbids a
  `Domain` attribute — the cookie is host-only.
* `AuthCookiePolicy.sameSite` accepts `'lax' | 'strict'` and **has no `'none'`**. That
  is deliberate; adding it would weaken the CSRF posture the design chose.
* `buildApp` configures **no CORS at all**, on the stated assumption that the dashboard
  is same-origin or behind a gateway.

Together those mean a browser on `*.vercel.app` cannot log in to an API on a different
registrable domain. Two arrangements work:

| Arrangement | Cookie changes | CORS | Cost |
|---|---|---|---|
| **Same-origin proxy**: Next.js rewrites `/api/*` to the container | none | none | `trustProxy` must be configured to trust exactly the proxy, or `request.ip` becomes the proxy for both the login rate limiter and every audit row |
| **Sibling subdomains** on one registrable domain (`app.` / `api.`) | none — same-site keeps `SameSite=Lax` working | must be added, with credentials and an exact origin | needs a domain the project owns |

The proxy is the smaller change and needs no domain. Its one real consequence,
`trustProxy`, is a genuine security setting and not a checkbox: `trustProxy: false` is
currently what makes `request.ip` unforgeable, and it is the rate-limit key.

Also deferred to 0.2B: the container host itself, HTTPS and the production cookie
profile, `apps/worker`, and a shared rate-limit store (the current limiter is
in-memory and therefore per-instance).

---

## 9. Verification of this sub-phase

| Gate | Where | Result |
|---|---|---|
| `pnpm format:check` | local | pass |
| `pnpm lint` | local | pass |
| `pnpm typecheck` | local | pass |
| `pnpm test` (unit) | local | pass — 709 tests, 29 files |
| `pnpm build` | local | pass |
| Live staging probes (§2) | local → Supabase | pass |
| `pnpm test:integration` including the new verification suite | CI | pass — run `33652249866`, **42/42 checks on both runs** |
| GitHub Actions CI | run `33652249866` | **green** |

---

### 7.4 The verification command was wrong twice, and CI said so

The first CI run reported **39 of 42**, and all three failures belonged to the command
rather than to the API. That is the argument for §4's last paragraph in one line: a
verification tool nobody verifies is a report generator.

* `GET /auth/me` returns the `CurrentUser` object directly, not wrapped in `{ user }`.
  The check read `.user.id`, found `undefined`, and failed a perfectly good 200. It now
  parses the response with `currentUserSchema`.
* The member checks answered 404 because the test harness wired only auth,
  authorization, clients and sites, while `apps/api/src/index.ts` also wires member
  administration. **An unwired route answers exactly like a broken one**, so the
  harness now builds the whole surface a deployment serves.

Both are fixed and the second run reports 42 of 42, twice — the second time being the
idempotence run.

---

## 10. Cloud posture, unchanged

Vercel holds no database credential and gained no variable. No Supabase Auth, JS client
or `service_role` is used anywhere. The staging schema was not migrated, and the failed
provisioning probe rolled back with zero rows created. Nothing was deployed.
