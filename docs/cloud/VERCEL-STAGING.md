# VERCEL-STAGING.md
# Web deployment

Status: **project not created** — see §5.

---

## 1. What is deployed here

**`apps/web` (Next.js) only.** The Fastify API is a separately deployable service and is
not deployed by this foundation; the reasoning is in
`docs/cloud/CLOUD-ARCHITECTURE.md` §4, and the short version is that a long-lived
connection pool, deliberately expensive Argon2id hashing and a container-shaped worker
that shares the same packages all argue against a serverless runtime for it.

The practical consequence is the good one: **Vercel holds no database credential.**
The web deployment today renders a static shell and reads exactly one public variable.

## 2. Project settings

These belong in the Vercel project, once created:

| Setting | Value | Why |
|---|---|---|
| Framework preset | Next.js | — |
| **Root Directory** | `apps/web` | the monorepo's web app |
| Include files outside root directory | **on** | the build needs `packages/*` |
| Install command | from `apps/web/vercel.json` | — |
| Build command | from `apps/web/vercel.json` | — |
| Node.js version | 24.x | matches `engines` and CI |

`apps/web/vercel.json` is checked in so these are reviewable in a diff rather than
living only in a dashboard:

```json
{
  "framework": "nextjs",
  "installCommand": "pnpm install --frozen-lockfile",
  "buildCommand": "cd ../.. && pnpm turbo run build --filter=@organic-os/web..."
}
```

Both commands are load-bearing, not ceremony:

- `@organic-os/config` resolves to `dist/`, so `next build` on its own fails — the
  workspace dependency has to be built first. `--filter=@organic-os/web...` builds the
  web app *and everything it depends on*, and nothing else.
- `--frozen-lockfile` makes a drifted lockfile a build failure rather than a silent
  re-resolution, which is the same guarantee CI enforces.

## 3. Environment variables

Two, and both are public by definition:

| Name | Class | Environments |
|---|---|---|
| `NEXT_PUBLIC_APP_NAME` | PUBLIC | Production, Preview, Development |
| `NEXT_PUBLIC_API_BASE_URL` | PUBLIC | Production, Preview, Development |

`NEXT_PUBLIC_API_BASE_URL` was added in Cloud 0.2 and is the *only* new value the web
deployment needed in order to know where the API is. It is a hostname the browser must
know to send a request at all, and knowing it grants nothing: the session is a
`__Host-` cookie the browser attaches to that origin. It is validated as an origin —
scheme, host and port, nothing else — so a path or a trailing slash cannot produce a
doubled slash in a request path, and plaintext is refused outside loopback
(`docs/cloud/API-STAGING.md` §7).

No `DATABASE_*`, no `AUTH_*`, no Supabase key of any kind is set on Vercel — not in
Cloud 0.1 and not after Cloud 0.2.
`packages/config` enforces the boundary in code: `@organic-os/config/client` accepts
only `NEXT_PUBLIC_*` and strips unknown keys, and there is no root export through which
`@organic-os/config/server` could be reached from a client bundle.

Full classification: `docs/cloud/ENVIRONMENT-MATRIX.md`.

## 4. Preview deployments

Safe by construction rather than by policy: previews inherit the same (empty) database
configuration as production, and the only workflow holding a staging credential is
`workflow_dispatch`-only. No pull request can migrate, provision or read the staging
database.

This has to be revisited when the API is deployed and previews need real data. The
answer then is an isolated preview database — Supabase branching — never shared staging
with elevated credentials.

## 5. Live result (2026-09-01)

**Deployed.** `apps/web` is on Vercel, linked to `hmagenavis/organic-growth-os`.

| Item | Value |
|---|---|
| Project | `organic-growth-os-web` |
| Vercel team | `itamaravis-1252's projects` (Hobby) |
| Linked GitHub identity | `hmagenavis` — the account that owns the repository |
| Root Directory | `apps/web` |
| Framework preset | Next.js |
| Branch | `main` |
| URL | `https://organic-growth-os-mjtractbg-itamaravis-1252s-projects.vercel.app` |

### Verified, not assumed

Checked against the live deployment rather than inferred from configuration:

| Check | Result |
|---|---|
| Application loads | 200, renders the Phase 0.1 shell, `<title>Organic Growth OS</title>` — which also proves `NEXT_PUBLIC_APP_NAME` was injected |
| `x-content-type-options` | `nosniff` |
| `referrer-policy` | `no-referrer` |
| `x-frame-options` | `DENY` |
| `strict-transport-security` | present |
| `x-powered-by` | **absent** — `poweredByHeader: false` holds in production |
| Secrets in HTML | **none** |
| Secrets in JavaScript | **none** — all six emitted chunks were fetched and scanned for `DATABASE_`, `SUPABASE_`, `service_role`, `postgres://`, `pooler.supabase`, `AUTH_SESSION_SECRET` and the three role names |
| Database credentials in the project | **none** — exactly one environment variable exists, `NEXT_PUBLIC_APP_NAME` |

**Vercel Authentication is on.** An unauthenticated request to the deployment URL gets
`302` to `vercel.com/sso-api`, so the staging build is not world-readable. That default
was kept rather than disabled: an unfinished application has no reason to be public, and
`X-Robots-Tag: noindex` is set as well.

### Deviation to be aware of

The import flow deploys the production branch, so the first deployment is a **Production**
deployment rather than a Preview one. Cloud 0.1 asked for Development/Preview only. The
practical exposure is nil — the project holds no secret, no database credential and no
custom domain, and it is behind Vercel Authentication — but it is a difference from the
brief and is recorded rather than glossed over. Changing the production branch to one that
does not exist would make every `main` push a Preview deployment instead; that has not been
done, because it would leave the project with no current deployment.

### The account tangle, and why it took what it took

Three GitHub identities are in play (`hmagenavis` owns the repository, `avisrismusic-star`
and `itamaravis-art` are linked to two other Vercel accounts). **Vercel resolves importable
repositories through the GitHub identity linked to the Vercel account** — not through which
GitHub App installations exist. A GitHub App installed on a personal account only ever
reaches repositories owned by that account, and personal accounts cannot be shared, so no
installation could bridge the gap. Two dead ends were eliminated by evidence before the
answer was found: granting `avisrismusic-star` write access (the error changed but the
import still failed) and installing the App directly from GitHub (never linked to any
Vercel account, because Vercel's callback never fired).

The resolution was a Vercel account with **no GitHub connection yet** — `itamaravis-1252` —
where connecting GitHub bound it to `hmagenavis` cleanly. The temporary collaborator grant
was **removed** once it was no longer needed; `hmagenavis` is again the sole collaborator.

Repository ownership was never changed and no second repository was created. One near-miss
is worth recording: Vercel's "enter a Git repository URL" path leads to a **clone** flow that
would have created `itamaravis-art/organic-growth-os` as a private copy and linked the
project to the copy — silently detaching CI, the gated `staging` environment and its secrets
from the deployment. It was stopped before the `Create` button.

## 6. Cloud 0.2: the custom domain, and why it is required rather than cosmetic

The web deployment moves from its generated `*.vercel.app` hostname to
`app.<domain>`, a subdomain of the same registrable domain the API serves from
(`api.<domain>`). That is the whole reason the domain exists in this phase.

`*.vercel.app` and the API platform's own domain are both on the Public Suffix List, so
they are different *sites*. Session and CSRF cookies carry the `__Host-` prefix and
`SameSite=Lax`, and `AuthCookiePolicy.sameSite` deliberately has no `'none'` — so on
two platform domains the browser would simply not send the session cookie, and no
amount of CORS would change that. One registrable domain makes the two origins
same-site and every cookie property stays exactly as designed. Full reasoning, and the
same-origin-proxy alternative that was evaluated and rejected, in
`docs/cloud/API-STAGING.md` §7.

Consequences for this project:

- **Vercel Authentication.** It is on, and it gates the deployment URL. It stays on for
  the generated hostname; whether it stays on for `app.<domain>` is a decision for when
  the dashboard exists, not now.
- **The API's CORS allowlist** is the exact `https://app.<domain>` origin, and nothing
  else.

## 7. Still deferred

- The Content-Security-Policy that ships with the dashboard (SECURITY.md §8).
- `apps/worker` — containers, never Vercel Functions (ADR-0005, ADR-0006). Cloud 0.3.
