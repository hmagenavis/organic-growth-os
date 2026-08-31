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

Only one, and it is public by definition:

| Name | Class | Environments |
|---|---|---|
| `NEXT_PUBLIC_APP_NAME` | PUBLIC | Production, Preview, Development |

No `DATABASE_*`, no `AUTH_*`, no Supabase key of any kind is set on Vercel in Cloud 0.1.
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

## 5. Human action required

Creating and linking a Vercel project requires an authenticated account and a
scope/team choice. It has not been done. Steps are in
`docs/phases/CLOUD-0.1-IMPLEMENTATION.md` §"Remaining human actions".

## 6. Deferred to Cloud 0.2

- Hosting for `apps/api` on a container platform, with the runtime connection string,
  `AUTH_SESSION_SECRET` and production cookie settings.
- A custom domain and the same-origin arrangement that lets `__Host-` session cookies
  work between web and API (ADR-0013, SECURITY.md §2).
- The Content-Security-Policy that ships with the dashboard (SECURITY.md §8).
- `apps/worker` — containers, never Vercel Functions (ADR-0005, ADR-0006).
