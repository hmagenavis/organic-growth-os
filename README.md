# Organic Growth OS

Autonomous SEO + AEO + GEO platform. Multi-tenant SaaS, WordPress-first.

Product and architecture documentation lives in [`docs/`](docs/):
[MASTER-PRD](docs/MASTER-PRD.md) · [ARCHITECTURE](docs/ARCHITECTURE.md) ·
[DATA-MODEL](docs/DATA-MODEL.md) · [SECURITY](docs/SECURITY.md) ·
[EXECUTION-SAFETY](docs/EXECUTION-SAFETY.md) · [ADRs](docs/ADR/README.md) ·
[phases](docs/phases/)

**Current state: Phase 0.1 — repository and tooling foundation.** There is no database,
authentication, queue, crawler or product functionality yet; those are built in later
Phase 0 sub-phases. See [PHASE-0.1-IMPLEMENTATION](docs/phases/PHASE-0.1-IMPLEMENTATION.md).

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

Every variable in `.env.example` is optional and non-secret — the defaults in
`packages/config` are used when a variable is unset. Never commit a real `.env`.

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

A single package can be targeted with `pnpm --filter @organic-os/api <script>`.

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
  observability/ Structured logging with redaction
docs/            Product, architecture and phase documentation
```

Packages are created in the phase that needs them, so the tree above grows over time
(`database`, `auth`, `integrations`, `crawler-core`, … — see
[ARCHITECTURE §4](docs/ARCHITECTURE.md)). Empty placeholder packages are not created.

**Dependency rule:** apps may depend on packages; packages never import from apps.
`@organic-os/config` exposes `/server` and `/client` entry points — server
configuration must never be imported from browser-bound code.
