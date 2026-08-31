# TESTING.md
# Organic Growth OS — Testing Strategy

Version: 1.0 (planning baseline)
Frameworks: Vitest (unit/integration), Playwright (E2E + screenshots), Testcontainers
(Postgres/Redis), recorded-fixture contract tests. CI: every PR runs typecheck, lint,
unit, integration, isolation tests; E2E + contract suites on main and nightly.

---

## 1. Pyramid (PRD §155)

| Layer | Scope | Where |
|---|---|---|
| Unit | domain logic: risk rules, scoring, hashing, diffing, clustering steps, capsule assembly, budget math | per package |
| Integration | repositories vs real Postgres (Testcontainers), queue flows vs real Redis, adapter wiring | per package + apps |
| Contract | Google APIs, WordPress REST/plugin, SERP providers — recorded fixtures, schema pinning | `packages/integrations` |
| E2E | dashboard → API → worker → mock WP → QA, per phase acceptance | `apps/*` + fixtures |
| Safety | rollback drills, tenant isolation, failure injection | dedicated suite |

Coverage rule: critical domain logic (risk engine, budget manager, tenancy layer,
patch/inverse-patch, QA checks, scoring) requires tests to merge — enforced by review,
not a blanket coverage percentage.

## 2. Tenant isolation suite (CI-blocking from Phase 0)

1. Seed org A and org B with mirrored data.
2. Run every repository method under A's `TenantContext`; assert zero B rows.
3. Raw-SQL RLS probes: as the app DB role with A's context, attempt direct selects/
   updates on B rows — must return empty / error.
3b. Pool-safety probe: set tenant context in a transaction, return the connection to
   the pool, check it out again — no tenant context may remain (asserts the
   `SET LOCAL`-only rule survives pooling). A lint rule bans non-LOCAL `SET` of
   `app.*` settings.
3c. Queue trust probe: enqueue a job whose payload tenant field mismatches the
   persisted run row it references — the worker must abort with an alert, touching
   no tenant data.
3d. LLM cache namespace probe: two tenants issue an identical tenant-scoped task
   input — assert two distinct cache entries (no cross-tenant hit); a
   registry-classified public task deduplicates in `global`.
4. API-level IDOR sweep: authenticated as A, request every `:id` route with B's ids —
   must 404.
5. Object-storage guard: presign attempts for B-prefixed keys under A's session fail.

## 3. Safety suite (from Phase 4)

- **Rollback drill:** execute action on test WP → force QA failure → assert automatic
  rollback restores snapshot-identical state (hash comparison), status `rolled_back`,
  alert raised. This is the Phase 4 acceptance test (PRD §169).
- **Rollback-failure drill:** force the restore itself to fail → assert terminal
  status `rollback_failed`, site-wide `EXECUTION_FREEZE` engaged, highest-severity
  alert raised, and remaining queued actions parked (EXECUTION-SAFETY.md §1, §10).
- **Terminal-semantics test:** a pre-write failure (e.g., preflight error) must end
  `failed` with zero CMS writes recorded; an ambiguous mid-write timeout must route
  through `rolling_back`, never straight to `failed`.
- **Snapshot-tier test:** per action type, assert the captured snapshot meets the
  platform minimum tier and that policy can raise but not lower it.
- **Idempotency:** re-deliver every job/write twice; assert single application.
- **State machine:** property tests that illegal `actions.status` transitions are
  rejected (engine + DB trigger).
- **Kill switch:** freeze mid-batch; assert parked, resumable, nothing lost.

## 4. Failure injection (PRD §158)

Simulated via adapter fault flags in integration tests: WordPress timeout, Google
quota exhaustion (429), Redis down (enqueue + consume paths), LLM provider error,
LLM invalid JSON (assert single repair retry then structured failure), half-finished
deploy (crash between execute and QA → recovery job resumes/rolls back), broken page
post-deploy, rollback failure (assert freeze + alert).

## 5. WordPress test environment (PRD §156)

- `wp-env`/Docker WordPress with matrix: Gutenberg, Elementor, Classic Editor, Yoast,
  RankMath, WooCommerce. Used by contract tests (read inventory, capability detection)
  and by Phase 4+ execution tests (apply/restore round-trips per builder/plugin combo).
- Plugin CI: PHP lint + endpoint tests against the matrix.

## 6. SEO fixture sites (PRD §157)

Static fixtures (checked-in HTML + sitemaps + robots) served locally for crawler and
audit determinism: small brochure site, blog, local business, WooCommerce-like,
multilingual (hreflang). Each fixture ships an expected-findings manifest, so the
technical audit is regression-tested against known ground truth.

## 7. LLM testing policy

- Unit/integration tests NEVER call live LLMs. The `llm` package ships a fake provider
  returning schema-valid canned outputs + failure modes.
- Prompt changes are evaluated offline against golden datasets (inputs → expected
  structured outputs) — an eval script, not CI-blocking initially.
- Budget/cache/router logic is pure code → unit-tested exhaustively (cache hit paths,
  escalation ladder, hard stops).

## 8. Per-phase acceptance tests

Each phase doc defines acceptance; they are implemented as executable E2E specs:
- Phase 0: secure login; create org/client/site; isolation suite green (PRD §165).
- Phase 1: connect WP; full crawl of fixture + test WP; pages visible in dashboard
  with hashes and audit findings (PRD §166).
- Later phases add theirs (kept in `docs/phases/*`).

## 9. Non-functional checks

- **Performance:** crawler throughput benchmark on fixtures; API p95 budget asserted
  in E2E (dashboard reads are precomputed — no heavy queries in request path).
- **Security:** dependency audit in CI; log-redaction unit tests; restore-from-backup
  drill documented as a runbook and exercised before first production tenant.
