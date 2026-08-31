# ADR-0006: Two-mode crawler (HTTP-first, Playwright escalation) inside the worker

Status: Accepted (2026-08-31 — crawler-in-worker approved; clean interfaces preserved
for later extraction to a dedicated service without domain-model redesign)

## Context
PRD §21 requires HTTP fast crawl by default and rendered crawl (Playwright) only on
escalation. PRD §133 sketches a standalone `apps/crawler`, but PRD §0/§179 forbid
over-engineering the MVP.

## Decision
1. **Two modes:** undici-based HTTP crawler as default; Playwright rendering only for
   URLs flagged by heuristics (JS-heavy, content mismatch between raw and expected,
   SPA markers). Rendered ratio is a tracked efficiency metric.
2. **Placement:** crawler logic lives in `packages/crawler-core` (pure, queue-free);
   execution runs in `apps/worker` under the `crawl` queue group, deployed as its own
   container (`WORKER_QUEUES=crawl`) with dedicated memory/concurrency limits for
   Playwright. A standalone `apps/crawler` is created only when operational isolation
   (scaling profile, security sandboxing) demands it — the package split makes that
   move mechanical.

## Alternatives considered
- Standalone crawler app now: duplicated bootstrap/observability/deploy for no current
  benefit.
- Rendered-always crawling: 10–50× CPU cost, violates PRD §21.
- Third-party crawl SaaS: core competency + data residency concerns; rejected.

## Consequences
- One worker image; deployment selects role. Playwright ships only in the worker
  image layer.
- Crawl politeness (robots, rate limits, budgets, trap avoidance) is implemented in
  crawler-core and unit-testable against fixtures.
