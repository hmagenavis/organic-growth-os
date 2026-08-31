# Organic Growth OS

Autonomous SEO + AEO + GEO platform. Multi-tenant SaaS, WordPress-first.

Product and architecture documentation lives in [`docs/`](docs/):
[MASTER-PRD](docs/MASTER-PRD.md) · [ARCHITECTURE](docs/ARCHITECTURE.md) ·
[DATA-MODEL](docs/DATA-MODEL.md) · [SECURITY](docs/SECURITY.md) ·
[EXECUTION-SAFETY](docs/EXECUTION-SAFETY.md) · [ADRs](docs/ADR/README.md) ·
[phases](docs/phases/)

**Current state: Phase 0.3 — authentication.** The repository holds the monorepo and
tooling ([0.1](docs/phases/PHASE-0.1-IMPLEMENTATION.md)), the multi-tenant database with
Row Level Security ([0.2](docs/phases/PHASE-0.2-IMPLEMENTATION.md)), and email/password
authentication with server-side sessions
([0.3](docs/phases/PHASE-0.3-IMPLEMENTATION.md)).

There is no _authorization_ yet: a valid session proves identity and nothing more — no
RBAC, no organization access, no product endpoints. That, along with queues, the
crawler and every SEO feature, arrives in later phases.

## Prerequisites

- **Node.js 24+**
- **pnpm 10.x** — `npm install -g pnpm@10`
  (pnpm 11 currently fails to install this dependency set on Windows; see
  [PHASE-0.1-IMPLEMENTATION](docs/phases/PHASE-0.1-IMPLEMENTATION.md) for details.)

On Windows, make sure npm's global binary directory (`%APPDATA%\npm`) is on `PATH`,
otherwise Turborepo cannot locate `pnpm`.

## Setup

```bash
cp .env.example .env
pnpm install
```

Most variables in `.env.example` are optional and non-secret. Two groups are not:
the database connection strings and `AUTH_SESSION_SECRET`. Their example values are
labelled local-development-only and must never be reused anywhere else; real
environments load them from a secret manager. Never commit a real `.env`.

With Docker running, bring up PostgreSQL and apply the schema:

```bash
docker compose up -d
pnpm db:bootstrap
pnpm db:migrate
```

## Scripts

Run from the repository root; Turborepo fans each task out across the workspace.

| Command             | Purpose                               |
| ------------------- | ------------------------------------- |
| `pnpm dev`          | Run web, api and worker in watch mode |
| `pnpm build`        | Build every package and app           |
| `pnpm typecheck`    | TypeScript, no emit                   |
| `pnpm lint`         | ESLint (type-aware)                   |
| `pnpm test`         | Vitest suites                         |
| `pnpm format`       | Apply Prettier (skips `docs/`)        |
| `pnpm format:check` | Verify formatting — CI gate           |

Database and maintenance commands:

| Command                  | Purpose                                           |
| ------------------------ | ------------------------------------------------- |
| `pnpm db:bootstrap`      | Create extensions and roles (superuser; once)     |
| `pnpm db:migrate`        | Apply pending migrations                          |
| `pnpm db:status`         | Report migration state (exit 2 when pending)      |
| `pnpm db:reset`          | Drop and rebuild — refuses anything but localhost |
| `pnpm test:integration`  | Vitest against real PostgreSQL (needs Docker)     |
| `pnpm db:verify:staging` | Verify a managed staging database (read-only)     |
| `pnpm sessions:cleanup`  | Delete finished sessions past the grace window    |

Tenant provisioning is an operator command, never an API (ADR-0018). It needs
`DATABASE_PROVISIONER_URL` and prompts for any new administrator's password with the
echo off — a password is never accepted as an argument. Rerunning with the same slug
creates nothing.

```bash
pnpm provision:organization --name "Acme Agency" --slug acme --email ada@acme.test
```

A single package can be targeted with `pnpm --filter @organic-os/api <script>`.

## Cloud / staging

Local Docker is a convenience, not a requirement: **GitHub Actions is the authoritative
verifier.** Every push runs the full suite against a disposable PostgreSQL created,
migrated and destroyed inside the runner, so a machine that cannot start Docker can
still get a definitive answer by pushing a branch.

Managed staging (Supabase) is a deployment target, never a substitute for that:

```bash
pnpm db:verify:staging   # read-only + rolled-back checks against a staging database
```

It refuses to run unless `STAGING_DB_HOST` matches the host inside every connection
string it is given, so it cannot be aimed at a database nobody meant to touch. Schema
changes reach staging only through the manual `staging-database` GitHub Actions
workflow — never from a web request, a push or a preview deployment.

See `docs/cloud/` for the architecture, the Supabase and Vercel setup, and the full
environment-variable matrix.

Local defaults: web on `http://localhost:3000`, api on `http://127.0.0.1:3001`
(`GET /health`).

## Layout

```text
apps/
  web/           Next.js dashboard shell
  api/           Fastify REST API
  worker/        Background worker process (queues arrive in Phase 0.5)
packages/
  contracts/     Shared Zod schemas and types
  config/        Environment validation; server/client split
  database/      Schema, migrations, tenant-scoped repositories, RLS
  auth/          Password hashing, sessions, cookies, CSRF, rate limiting
  observability/ Structured logging with redaction
docs/            Product, architecture and phase documentation
```

Packages are created in the phase that needs them, so the tree above grows over time
(`integrations`, `crawler-core`, `llm`, … — see
[ARCHITECTURE §4](docs/ARCHITECTURE.md)). Empty placeholder packages are not created.

**Dependency rule:** apps may depend on packages; packages never import from apps.
`@organic-os/config` exposes `/server` and `/client` entry points — server
configuration must never be imported from browser-bound code.
