# PHASE-1.md — Read-Only Site Intelligence

Status: NOT STARTED (blocked on Phase 0 exit gate)
PRD source: §166 (+ §16–§23, §91–§92 read-only portions)
Duration estimate: 3–5 weeks
Exit gate: BUILD → TEST → REVIEW → SECURITY → COST REVIEW

## Goal

Connect a WordPress site, crawl it, build the Digital Twin, and show a page inventory
with a deterministic technical audit — **zero writes to the site, zero LLM calls.**
(The first LLM/token spend arrives in Phase 2+; Phase 1 proves the deterministic
foundation and the hash/caching layer that later keeps AI costs down.)

## Scope

### 1.1 WordPress connectivity
- `CmsConnector` WordPress implementation: verify, content inventory, content detail,
  capability detection (builders, SEO plugin, WooCommerce) via REST + plugin.
- **OrganicOS Connector plugin v1 (read-only build):** `/health`, `/capabilities`,
  `/inventory`, `/content/:id` with HMAC request verification (SECURITY.md §6).
  Write endpoints do not exist in this build.
- Integration UI: connect with URL + application password; health panel; revoke.
- Graceful REST-only degradation when the plugin isn't installed (fewer fields,
  surfaced as reduced-capability status — not silent).

### 1.2 Crawl engine (`crawler-core` + `crawl` queue group)
- HTTP-first crawler (undici): robots.txt + meta robots respect, per-site rate limits
  and crawl budgets, redirect chains, trap avoidance (parameters, calendars, infinite
  pagination heuristics) per PRD §22.
- Configurable hard limits enforced from day one (PRD §193 / ARCHITECTURE.md §7.1):
  max URLs per run, max depth, per-host/per-site/global concurrency, req/sec rate
  limit. Hitting a hard limit parks the run with a visible status — never silent
  truncation.
- Playwright rendered mode, escalation-only: content mismatch/JS-heavy detection
  triggers rendering for that URL (PRD §21); rendered ratio is a tracked metric.
- Extraction: title/meta/canonical/robots, headings, links (in/out), images+ALT,
  hreflang, schema JSON-LD, word count, **boilerplate-removed main content**.
- Hashing: content/heading/metadata/schema/template hashes per page version (PRD §9).
- Full crawl (onboarding) + incremental crawl (changed/new/error/priority pages,
  PRD §23) with resumable runs and per-run stats.
- SSRF guards per SECURITY.md §6.

### 1.3 Digital Twin
- `pages`, `page_versions`, `crawl_runs`, `crawl_pages`, `sitemaps` per DATA-MODEL.md
  §5; provenance/freshness per field group; version created only when a hash changed.
- Sitemap fetch/parse/validate (index + urlset), sitemap-vs-crawl reconciliation
  (in sitemap but 404 / crawled but missing, etc.).

### 1.4 Technical audit (deterministic only — `technical-seo` package)
Rule engine over the twin (PRD §91 subset feasible without GSC):
status codes & broken internal links, redirect chains/loops, missing/duplicate
title/meta/H1, multiple H1s, canonical issues, noindex/robots conflicts, orphan pages
(crawl-graph based), thin content (word-count heuristic), image ALT coverage,
schema syntax validation, hreflang consistency, sitemap issues.
Each finding: evidence, affected URLs, severity — stored, explainable, re-computed
incrementally on hash change.

### 1.5 Dashboard
- Site overview: crawl status/history, page counts by type/status, issue summary.
- Pages table: filter/search/sort, issue badges; Page detail: versions, hashes,
  metadata, links, findings with evidence.
- Crawl controls: start full/incremental (RBAC-gated), progress via job polling.

## Explicitly OUT of scope
Any site writes (plugin has no write endpoints), GSC/GA4/GTM, keywords, LLM calls,
embeddings, opportunities/scoring, SERP, screenshots-as-QA (screenshots only later).

## Acceptance criteria (PRD §166, executable)
1. Connect WordPress (test env + at least one real site) with health verification.
2. Full crawl completes on all fixture sites + test WP; stats recorded; re-crawl of
   unchanged site creates zero new page versions (hash gate proof).
3. Incremental crawl picks up an edited fixture page and only that page re-analyzes.
4. Pages + findings visible in dashboard with evidence; audit matches each fixture's
   expected-findings manifest exactly.
5. Rendered-mode escalation triggers on the JS fixture only (efficiency proof).
6. Tenant isolation suite still green with two orgs crawling different sites
   concurrently.

## Cost review gate (specific to this phase)
LLM spend must be exactly $0. Crawler infrastructure cost per 1,000 pages measured
and recorded as the baseline for the Token/AI KPIs introduced in Phase 2.
