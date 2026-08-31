# PHASE-0.md — Foundation

Status: IN PROGRESS — §0.1, §0.2 and the authentication half of §0.3 complete and
verified (2026-08-31, see PHASE-0.1/0.2/0.3-IMPLEMENTATION.md); RBAC (the other half of
§0.3) and §0.4–§0.6 not started
PRD source: §165
Duration estimate: 2–3 weeks of focused work
Exit gate: BUILD → TEST → REVIEW → SECURITY → COST REVIEW (PRD §0)

## Goal

A secure, multi-tenant, observable skeleton: monorepo, CI, database, auth, RBAC,
queue, config, secrets, feature flags. **No SEO functionality.** Everything built here
is production-grade — no placeholders (PRD §0).

## Scope

### 0.1 Monorepo & tooling — COMPLETE
- pnpm workspaces + Turborepo; TypeScript strict base config; ESLint (type-aware) +
  Prettier.
- Apps scaffolded: `web` (Next.js), `api` (Fastify + `/health`), `worker` (process
  lifecycle only; queue wiring belongs to §0.5).
- Packages created: `contracts`, `config`, `observability`. Packages are created by
  the sub-phase that fills them — `database` in §0.2, `auth` in §0.3, `ui` with the
  dashboard in §0.4 — because empty placeholder packages are forbidden (PRD §0).
- CI (GitHub Actions): format, lint, typecheck, test, build, critical-vulnerability
  audit; blocking. Integration (Testcontainers Postgres/Redis) and the
  tenant-isolation suite are added by §0.2/§0.3 when there is a database to test.
- Commit hooks deferred: CI enforces the same gates; revisit if pre-push friction
  appears.

### 0.2 Database & migrations — COMPLETE
- Drizzle + migration runner (forward-only); separate migration role vs runtime role
  (plus a provisioning role, since tenant creation must not require DDL rights).
- Domain A tables (organizations, users incl. `is_platform_admin`, memberships,
  membership_client_scopes, sessions, clients, sites, site_settings, feature_flags)
  + `audit_logs` + `integrations`/`integration_tokens` shells (Domain B) per
  DATA-MODEL.md.
- RLS enabled + policies on all tenant tables; runtime role cannot bypass; tenant
  context via `SET LOCAL` only (pool-safety probe in CI, TESTING.md §2).

### 0.3 Auth & RBAC
Split in two, because they answer different questions and the boundary between them is
load-bearing: authentication asks *who is this*, authorization asks *what may they do*.

**0.3a Authentication — COMPLETE.**
- Email/password (argon2id), server-side sessions, secure cookies, CSRF protection,
  login rate limiting per SECURITY.md §2. Session rotation, revocation and cleanup.
- A valid session establishes identity only: it sets no tenant context and grants no
  organization access. Held in place by a test (PHASE-0.3-IMPLEMENTATION.md §11).

**0.3b RBAC — moved to 0.4**, where it joins the tenant-context selection it depends
on. Audit-log rows for auth events move with it: `audit_logs` is tenant-scoped and an
authentication event has no organization at the moment it happens.
- RBAC matrix as data + authorization module; deny by default; org roles only
  (agency_admin, seo_manager, content_editor, analyst, client_viewer) with
  normalized `membership_client_scopes` restriction.
- Platform administration: `users.is_platform_admin` flag, settable only by
  migration/seed or audited manual SQL (no API), gating a separate platform-admin
  route group (SECURITY.md §3).
- Audit log writes for all auth and admin mutations.

### 0.4 API & web
- Fastify app: Zod validation boundary, problem+json errors, request IDs, OpenAPI
  generation from `contracts`; Phase-0 endpoint group from API-CONTRACTS.md §2.
- Next.js dashboard: login, org switcher-free single-org view, clients list/create,
  sites list/create, members & roles admin, audit log view (admin).
  Loading/error/empty states for every screen (PRD §190).

### 0.5 Queue & workers
- BullMQ wiring, queue registry, `JobEnqueuer` with idempotency keys, tenant context
  propagation, graceful shutdown, dead-letter handling, `jobs/:id` status endpoint.
- One real job to prove the loop end-to-end (e.g. `integration.verify` no-op shell is
  NOT acceptable — use a real job: audit-log compaction or session cleanup).

### 0.6 Config, secrets, flags, observability
- `packages/config`: Zod-validated env; fail-fast startup.
- Secret handling + envelope-encryption utilities (SECURITY.md §5) with unit tests.
- DB-backed feature flags + typed accessor.
- Configuration defaults (values + typed accessors only; enforcement ships with the
  features they govern): retention periods (DATA-MODEL.md §12), ingestion/quota
  limits (ARCHITECTURE.md §7.1), safety graduation policy baseline
  (EXECUTION-SAFETY.md §3.1). `site_settings` rows are created with
  `autopilot_mode = 'review'` by default.
- pino structured logging with redaction; OpenTelemetry bootstrap; base metrics
  (HTTP latency, job counts, queue depth).

## Explicitly OUT of scope
WordPress anything, crawler, GSC/GA4, LLM package, opportunities, execution paths,
billing, MFA/SSO (columns reserved only).

## Acceptance criteria (PRD §165, executable as E2E specs)
1. Secure login/logout; session expiry; cookie/CSRF configured as specified.
2. Create organization → client → site via UI and API.
3. RBAC: each role can/cannot per SECURITY.md §3 matrix (tested).
4. Tenant isolation suite green (repositories, RLS probes, IDOR sweep).
5. Token encryption round-trip; no plaintext secrets in DB dump or logs.
6. CI blocks on any of the above failing.

## Deliverable review checklist
- [ ] Diff reviewed against CLAUDE.md core rules
- [ ] Security review vs SECURITY.md §10 gate
- [ ] No `any` without justification; no placeholder implementations
- [ ] Docs updated where behavior differs from plan
