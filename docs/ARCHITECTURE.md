# ARCHITECTURE.md
# Organic Growth OS — System Architecture

Version: 1.1 (planning baseline, pre-implementation)
Status: Approved 2026-08-31 (direction + PRD amendments). Phase 0 implementation NOT started — awaiting explicit go.
Source of truth for product scope: `docs/MASTER-PRD.md`
Related: `docs/DATA-MODEL.md`, `docs/API-CONTRACTS.md`, `docs/AI-COST-ARCHITECTURE.md`,
`docs/SECURITY.md`, `docs/EXECUTION-SAFETY.md`, `docs/TESTING.md`, `docs/ADR/`

---

## 1. Architecture principles (binding)

1. **Deterministic orchestration.** Workflows are driven by code, queues and state machines.
   LLMs are leaf calls inside deterministic pipelines, never the orchestrator (PRD §3.1, §144).
2. **Token efficiency is architecture, not optimization.** Every pipeline is a funnel:
   deterministic code → SQL → hashing/diffing → embeddings → LLM only on the filtered remainder
   (PRD §4, §186). Details in `AI-COST-ARCHITECTURE.md`.
3. **Safety over autonomy.** No production write outside the
   Action → Risk → Snapshot → Patch → Preflight → Execute → QA → Commit/Rollback pipeline
   (PRD §103, §188). Details in `EXECUTION-SAFETY.md`.
4. **Multi-tenant isolation from day one.** Every tenant-scoped row carries tenancy columns;
   isolation is enforced at the data-access layer AND by Postgres RLS as defense in depth
   (ADR-0002). Leakage tests are mandatory CI gates.
5. **All external providers behind adapters.** WordPress, Google APIs, SERP, backlinks,
   LLM providers, embeddings, object storage, email — all replaceable interfaces (ADR-0011).
6. **Read/write separation by phase.** Phases 0–3 are read-only intelligence. Write paths
   (execution engine) do not exist in the codebase until Phase 4, so they cannot be
   accidentally invoked earlier.
7. **Web requests never do heavy work.** Crawling, analysis, embeddings, LLM calls, QA all
   run as queue jobs. The dashboard reads precomputed data (PRD §161).

---

## 2. System overview

```text
                ┌──────────────────────────────────────────────────────────┐
                │                        apps/web                          │
                │        Next.js dashboard (SSR + client components)       │
                └───────────────┬──────────────────────────────────────────┘
                                │ REST (OpenAPI, cookie session)
                ┌───────────────▼──────────────────────────────────────────┐
                │                        apps/api                          │
                │  Fastify. AuthN/AuthZ, tenancy context, validation,      │
                │  CRUD, job enqueue, report reads. NO heavy work.         │
                └───────┬──────────────────────────────┬───────────────────┘
                        │ SQL (tenant-scoped)          │ enqueue (BullMQ)
                ┌───────▼───────┐              ┌───────▼───────────────────┐
                │  PostgreSQL   │              │          Redis            │
                │  + pgvector   │              │   queues / rate limits    │
                └───────▲───────┘              └───────┬───────────────────┘
                        │                              │ consume
                ┌───────┴──────────────────────────────▼───────────────────┐
                │                      apps/worker                         │
                │  BullMQ processors, grouped by queue. Deployable as      │
                │  separate processes per queue group:                     │
                │   - crawl        (HTTP crawler; Playwright escalation)   │
                │   - analyze      (technical audit, hashing, diffing)     │
                │   - embed        (embedding generation)                  │
                │   - llm          (budgeted structured LLM tasks)         │
                │   - ingest       (GSC / GA4 / GTM pulls)                 │
                │   - execute*     (Phase 4+: safe execution pipeline)     │
                │   - qa*          (Phase 4+: post-deploy QA)              │
                │   - monitor      (schedules, anomaly baselines)          │
                │   - report       (report generation)                     │
                └───────┬──────────────────────────────┬───────────────────┘
                        │                              │
              ┌─────────▼─────────┐          ┌─────────▼──────────────────┐
              │  Object storage   │          │   External providers        │
              │  (S3-compatible)  │          │   (adapters only):          │
              │  snapshots,       │          │   WordPress (REST+plugin),  │
              │  screenshots,     │          │   GSC, GA4, GTM, SERP,      │
              │  reports, imports │          │   LLM, embeddings, PSI…     │
              └───────────────────┘          └────────────────────────────┘
```

`*` The `execute` and `qa` queues and their code are introduced in Phase 4, not before.

### 2.1 Deployment topology

- **MVP:** one web deployment, one API deployment, N worker containers
  (same image, `WORKER_QUEUES=crawl,analyze,...` selects processors), one Postgres,
  one Redis, one S3 bucket set. Everything horizontally scalable except Postgres (vertical
  first, read replicas later).
- **Crawler placement (deviation from PRD §133):** the crawler is a queue group inside
  `apps/worker`, deployed as its own worker process (own container, own concurrency and
  memory limits for Playwright). It is promoted to a standalone `apps/crawler` only if
  operational isolation demands it. Rationale in ADR-0006. This avoids a fourth app with
  duplicated infrastructure while keeping runtime isolation.

---

## 3. Technology stack (decisions)

| Concern | Choice | ADR |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | ADR-0001 |
| Language | TypeScript strict everywhere (plugin: PHP) | — |
| Frontend | Next.js (App Router), Tailwind, shadcn/ui | ADR-0013 |
| API | Fastify, REST, OpenAPI generated from Zod schemas | ADR-0004 |
| Database | PostgreSQL 16+ with pgvector | ADR-0002 |
| ORM / migrations | Drizzle ORM + explicit SQL migrations, no auto-mutation | ADR-0003 |
| Queue | Redis + BullMQ | ADR-0005 |
| Object storage | S3-compatible via `StorageProviderInterface` | ADR-0011 |
| Crawler | undici HTTP-first; Playwright rendered mode on escalation | ADR-0006 |
| LLM | `LLMProviderInterface`; configurable FAST/BALANCED/STRONG router | ADR-0007 |
| LLM cost control | Token budgets, cache, hashing, diff analysis as infrastructure | ADR-0008 |
| Execution safety | Action state machine, snapshots, QA, rollback | ADR-0009 |
| WordPress | REST API + OrganicOS Connector plugin (safety bridge) | ADR-0010 |
| Auth | Cookie sessions (server-side), argon2id, RBAC | see SECURITY.md |
| IDs | UUIDv7 primary keys; human-readable Action IDs (`ACT-YYYY-NNNNNN`) | — |
| Observability | Structured logs (pino), OpenTelemetry traces, metrics | — |

Model names, API keys, budgets, and risk thresholds are **configuration**, never hardcoded.

---

## 4. Repository structure (MVP-right-sized)

The PRD (§133) lists ~25 packages. Creating them all on day one is over-engineering
(violates PRD §0 "do not over-engineer the MVP"). We start with the packages the current
phase needs and split when a boundary becomes real. Package names match the PRD so later
splits are renames-free.

```text
organic-growth-os/
├── apps/
│   ├── web/                  # Next.js dashboard
│   ├── api/                  # Fastify REST API
│   └── worker/               # BullMQ processors (incl. crawl queue group)
│
├── packages/
│   ├── contracts/            # Zod schemas, shared types, OpenAPI source of truth
│   ├── database/             # Drizzle schema, migrations, tenant-scoped repositories
│   ├── config/               # typed env + runtime configuration loader
│   ├── auth/                 # sessions, RBAC, password hashing
│   ├── integrations/         # adapter interfaces + provider implementations
│   ├── crawler-core/         # fetch, parse, extract, hash (no queue coupling)
│   ├── technical-seo/        # deterministic audit rules (Phase 1)
│   ├── llm/                  # router, budgets, cache, prompt registry (Phase 2+)
│   ├── observability/        # logger, metrics, tracing helpers
│   └── ui/                   # shared UI components (grows with web)
│
├── wordpress-plugin/         # OrganicOS Connector (Phase 1: read-only endpoints)
├── docs/                     # this documentation set
└── .claude/                  # agents, skills, settings
```

Packages added later, in the phase that needs them (names reserved per PRD §133):
`keyword-engine`, `search-intelligence` (Phase 2); `opportunity-engine`, `page-intelligence`
(Phase 3); `execution-engine`, `qa-engine` (Phase 4); `link-engine`, `schema-engine`
(Phase 5); `content-engine` (Phase 6); `aeo-engine`, `geo-engine` (Phase 9);
`conversion-engine` (Phase 11); `learning-engine` (Phase 12); `reporting`, `security`
(extracted when substantial).

**Dependency rule:** `apps/*` may depend on `packages/*`. Packages may depend only on
packages below them in this order: `contracts` → `config`/`observability` →
`database`/`auth` → `integrations`/`llm`/`crawler-core` → domain engines. No package
depends on an app. Domain engines never import from `apps/*` or from each other's
internals — cross-engine communication goes through `contracts` types and the database.

---

## 5. Core domain flows

### 5.1 Deterministic orchestration model

Every long-running process is a **run** row in Postgres (e.g. `crawl_runs`, executions,
QA runs) plus BullMQ jobs. State transitions are explicit and persisted; jobs are
idempotent (idempotency key = run id + step + target id) so retries never duplicate work
(PRD §162). BullMQ flows (parent/child jobs) model fan-out (crawl → per-page analyze).
There is no LLM-driven planning loop at runtime.

**Queue payload rule:** job payloads carry IDs/references and minimal routing metadata
only — never secrets, OAuth tokens, full HTML, large content payloads, or full LLM
prompts. Workers load what they need from Postgres/object storage under a
`TenantContext` derived from the trusted persisted run/action row the payload
references (SECURITY.md §4) — a tenant field in a payload is never trusted on its own.

### 5.2 Ingestion → Digital Twin (Phases 1–2)

```text
WordPress inventory (plugin/REST)  ─┐
Crawler (HTTP-first)               ─┤→ pages + page_versions (content-hashed)
Sitemap/robots parsing             ─┤→ deterministic technical audit findings
GSC / GA4 pulls (Phase 2)          ─┘→ page_metrics / gsc_metrics / ga4_metrics
```

- Each crawled page produces `content_hash`, `heading_hash`, `metadata_hash`,
  `schema_hash`, `template_hash` (PRD §9). Unchanged hash ⇒ no re-analysis, no
  re-embedding, no LLM.
- Boilerplate removal happens at extraction time; only main content is stored as the
  analyzable text (PRD §12).
- Incremental crawls prioritize changed/new/important/error pages (PRD §23).

### 5.3 Analysis funnel (Phase 3+)

```text
ALL pages/queries
  → SQL + rules (404s, duplicate titles, CTR gaps, orphans…)      [no LLM]
  → hashing / diffing (what actually changed)                     [no LLM]
  → embeddings (similarity, clustering, link candidates)          [no LLM]
  → small Top-K context assembly (capsules, PRD §5, §13)
  → structured LLM call (JSON schema output, budgeted, cached)    [LLM leaf]
  → opportunities (explainable, versioned scoring)
```

### 5.4 Safe execution (Phase 4+)

Fully specified in `EXECUTION-SAFETY.md`. Summary: every write is an `action` with a
risk class (GREEN/YELLOW/RED), a pre-change snapshot in object storage, a structured
patch, preflight validation, execution through the WordPress adapter, deterministic QA,
and commit or automatic rollback. Canary batching for bulk actions. Autopilot modes
gate what may run without human approval.

### 5.5 Hierarchical context system

The 5 capsule levels (Organization / Site / Topic / Page / Task — PRD §5) are
**materialized, versioned rows**, not ad-hoc prompt assembly. Capsules are rebuilt only
when their inputs' hashes change. Task context assembly selects the minimal capsule set
for each LLM task. Specified in `AI-COST-ARCHITECTURE.md`.

---

## 6. Multi-tenancy model

Hierarchy: `organization` (agency) → `client` → `site`. Users belong to organizations
via `memberships` with roles (PRD §142).

- Every tenant-scoped table carries `organization_id` (always) and `client_id`/`site_id`
  where applicable, denormalized for isolation enforcement and indexing.
- **Layer 1:** all queries go through tenant-scoped repositories in `packages/database`
  that require a `TenantContext` — there is no exported "unscoped" query path for
  tenant-scoped tables.
- **Layer 2:** Postgres Row-Level Security on tenant-scoped tables, keyed on
  `app.current_org_id` set **transaction-locally only** (`SET LOCAL` /
  `set_config(..., true)` inside the transaction — never session-level state, which
  could survive connection-pool checkouts). The API/worker runtime uses a
  non-superuser role that cannot bypass RLS.
- Cross-client learning uses only aggregated, anonymized `learning_records` fields; raw
  URLs/queries/content never cross tenants (PRD §128).
- Full details and threat model: `SECURITY.md`; schema conventions: `DATA-MODEL.md`;
  decision rationale: ADR-0002.

---

## 7. Configuration & feature flags

- Typed, Zod-validated env config in `packages/config`; startup fails fast on invalid env.
- Runtime configuration (model router mapping, budgets, risk overrides, autopilot mode,
  crawl budgets) lives in the database (`site_settings`, `cost_budgets`, org settings)
  with sane defaults — never hardcoded.
- Feature flags (simple DB-backed table + typed accessor, no external service in MVP)
  gate: Google AI data sources, social platform properties, AI crawler tracking,
  experimental features (PRD §164). Unavailable data sources render as
  `DATA SOURCE NOT PROGRAMMATICALLY AVAILABLE` — never scraped or faked (PRD §26).

### 7.1 Ingestion & quota controls (PRD §193 — all configurable, never hardcoded)

Env defaults + per-org/site DB overrides (`site_settings`, `sites.crawl_budget`).
Proposed defaults:

| Limit | Default |
|---|---|
| Max crawl URLs per run | 10,000 |
| Max crawl depth | 10 |
| Crawl concurrency per host / per site / global | 2 / 4 / 32 |
| Crawl rate limit (req/sec per host) | 2 (robots.txt respected first) |
| Rendered-crawl share alarm threshold | >15% of run |
| Max keyword import rows per file | 50,000 |
| GSC ingest: max rows per site per day | 50,000 (dimension sets capped) |
| GSC incremental sync | daily deltas after initial backfill; windows computed from rollups |
| BigQuery bulk-export recommendation trigger | GSC API rows at cap 7 consecutive days |

The BigQuery switch is a surfaced recommendation to the user, never automatic.
Exceeding a hard limit parks the run with a visible status — never silent truncation.

---

## 8. Observability

- **Logs:** pino structured JSON; every log line carries `org_id`, `site_id`, `job_id`,
  `trace_id` where applicable. Secrets/tokens are redacted at the serializer level.
- **Traces:** OpenTelemetry SDK in api + worker; spans for jobs, provider calls, LLM calls.
- **Metrics:** job throughput/failures, queue depth, API latency, crawler fetch rate,
  LLM tokens & cost (per client/module/task), QA pass rate, rollback rate (PRD §159).
- **Cost dashboard** reads from `llm_calls` aggregates (PRD §160) — see
  `AI-COST-ARCHITECTURE.md`.

---

## 9. PRD contradictions, tensions and risks — resolution status

Items 1–3, 5, 7, 8 were approved and folded into the PRD on 2026-08-31.

1. **§133 (25 packages) vs §0/§179 (don't over-engineer).** ✅ RESOLVED (approved):
   start with 10 packages, reserve names, split by phase (§4 above; PRD §133 amended;
   ADR-0001 Accepted). Crawler interfaces stay clean (`crawler-core` is queue-free and
   app-free) so extraction to a dedicated service later requires no domain-model change.
2. **§106 default autopilot.** ✅ RESOLVED (approved): default for new sites is
   **REVIEW**; SAFE_AUTOPILOT is explicit per-site opt-in behind a configurable
   safety graduation policy (PRD §106 amended; ADR-0014 Accepted;
   EXECUTION-SAFETY.md §3).
3. **§133 standalone `apps/crawler` vs MVP scope.** ✅ RESOLVED (approved): worker
   queue group with dedicated deployment (§2.1; PRD §133 amended; ADR-0006 Accepted).
4. **GSC data volume (§24).** ⚠️ RISK, mitigated by design: raw daily rows partitioned
   monthly + pre-computed rollups; configurable ingest caps (§7.1); BigQuery bulk
   export recommended when the API caps out (PRD §193). Remains a top technical risk
   to validate with real large-site data.
5. **§16 WordPress plugin scope.** ✅ RESOLVED (approved): phased plugin — Phase 1
   read-only build; write endpoints only with Safe Execution phases (PRD §16 amended;
   ADR-0010 Accepted).
6. **§77 AI Visibility Tracker legal/ToS surface.** ⚠️ Standing constraint: only
   official APIs; every provider behind a flag; costs metered. Results labeled
   "Synthetic AI Visibility Measurement".
7. **Billing/subscriptions.** ✅ CONFIRMED out of scope for V1 (PRD §184 amended).
8. **Data retention.** ✅ RESOLVED (approved): policy added as PRD §192; defaults and
   enforcement in DATA-MODEL.md §12; legal/security deletion in SECURITY.md §9.
9. **§20 Digital Twin lists ~50 attributes per URL.** Not all are available in Phase 1;
   the twin schema marks provenance and freshness per field group rather than pretending
   completeness.
10. **Attribution honesty (§102) vs ROI forecast (§40).** Both are estimates; UI must
    label them as such. No causal claims — enforced in reporting contracts.

---

## 10. What is explicitly NOT built in the MVP

Per PRD §184 plus architectural judgment:

- No execution/write path of any kind (until Phase 4 approval).
- No multi-agent runtime, no agent-spawning (PRD §144, §149).
- No standalone crawler app, no distributed crawler.
- No schema-per-tenant or per-tenant databases.
- No GraphQL, no gRPC, no event-sourcing/CQRS — plain REST + queue jobs.
- No external feature-flag/config service; DB-backed flags suffice.
- No SERP scraping, no Search Console UI scraping, no unofficial APIs.
- No backlink index of our own; provider adapter only, later phase.
- No Elementor/builder write adapters in V1 execution scope.
- No self-healing beyond design placeholder-free stubs — none until Phase 12.
- No billing.
