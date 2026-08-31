# Architecture Decision Records

Format: context → decision → consequences. Status values: Proposed / Accepted /
Superseded. All ADRs below are **Accepted** as of the 2026-08-31 Phase 0 go decision.
Accepted decisions are not reopened unless implementation reveals a concrete blocker;
a blocker produces a new ADR that supersedes the old one.

| # | Title | Status |
|---|---|---|
| [0001](0001-monorepo-pnpm-turborepo.md) | Monorepo with pnpm + Turborepo | Accepted |
| [0002](0002-single-db-multitenancy-rls.md) | Single-DB multi-tenancy: scoped repositories + Postgres RLS | Accepted |
| [0003](0003-drizzle-explicit-migrations.md) | Drizzle ORM with explicit, forward-only SQL migrations | Accepted |
| [0004](0004-fastify-rest-zod-openapi.md) | Fastify REST API; OpenAPI generated from Zod contracts | Accepted |
| [0005](0005-bullmq-deterministic-orchestration.md) | BullMQ job orchestration; no LLM-driven workflows | Accepted |
| [0006](0006-crawler-two-modes-worker-placement.md) | Two-mode crawler (HTTP-first, Playwright escalation) inside worker | Accepted |
| [0007](0007-llm-provider-abstraction-model-router.md) | LLM provider abstraction + configurable FAST/BALANCED/STRONG router | Accepted |
| [0008](0008-token-cost-controls-as-infrastructure.md) | Token budgets, cache, hashing, diffs as first-class infrastructure | Accepted |
| [0009](0009-execution-state-machine.md) | Safe execution as a persisted state machine with snapshots & rollback | Accepted |
| [0010](0010-wordpress-plugin-safety-bridge.md) | WordPress connector plugin as phased safety bridge (read-only v1) | Accepted |
| [0011](0011-adapter-pattern-for-providers.md) | Adapter interfaces for every external provider | Accepted |
| [0012](0012-deterministic-first-funnel.md) | Deterministic-first analysis funnel; LLM as filtered leaf | Accepted |
| [0013](0013-cookie-sessions-over-jwt.md) | Server-side cookie sessions instead of JWTs | Accepted |
| [0014](0014-default-autopilot-review.md) | Default autopilot = REVIEW + configurable Safety Graduation Policy | Accepted |

## Implementation-time addenda

- **ADR-0004 (TypeScript version):** the toolchain pins TypeScript 5.9.x, not the
  newer 7.x line, because `typescript-eslint` supports `>=4.8.4 <6.1.0`. Revisit when
  the lint toolchain supports TS 7. Recorded in `docs/phases/PHASE-0.1-IMPLEMENTATION.md`.
