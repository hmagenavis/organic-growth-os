# DATA-MODEL.md
# Organic Growth OS — Database Domain Map & Schema Conventions

Version: 1.0 (planning baseline)
Database: PostgreSQL 16+ with pgvector
ORM: Drizzle, explicit SQL migrations only (ADR-0003)
Tenancy: single database, shared schema, RLS defense-in-depth (ADR-0002)

This document defines conventions, the domain map, and column-level detail for the
tables that carry the most architectural weight. Full DDL is produced per-phase as
migrations; tables are **created in the phase that uses them**, not all up front.

---

## 1. Conventions (binding)

- **Primary keys:** `id uuid` (UUIDv7) unless noted. Human-facing IDs (e.g.
  `ACT-2026-000001`) are separate unique columns backed by sequences.
- **Tenancy columns:** every tenant-scoped table has `organization_id uuid NOT NULL`;
  tables under a client/site also carry `client_id` / `site_id` (denormalized on
  purpose). Composite indexes lead with the tenancy column actually used for lookup
  (usually `site_id`).
- **RLS:** enabled on all tenant-scoped tables; policy checks
  `organization_id = current_setting('app.current_org_id', true)::uuid`. Worker/API
  roles cannot bypass RLS. Tenant context is established with **transaction-local
  state only** — `SET LOCAL app.current_org_id = ...` inside the transaction (or the
  transaction-scoped `set_config(..., true)` equivalent). Session-level `SET` is
  forbidden: pooled connections must never carry tenant state across checkouts.
  Workers derive the tenant from **trusted persisted rows** (the run/action record
  they are processing), never from an `organization_id` supplied only in a queue
  payload. Aggregation across tenants (cross-client learning, ops dashboards) uses a
  dedicated role via views that expose only anonymized aggregates.
- **Timestamps:** `created_at`, `updated_at` (`timestamptz`, UTC) everywhere; soft
  delete only where product-visible (`deleted_at`), otherwise hard delete + audit log.
- **Versioning over mutation:** entities whose history matters (page content, schema,
  scores, prompts, scoring formulas) get version tables; the head row points at the
  current version.
- **Hashes:** `bytea`/hex `text` SHA-256. Content identity is always hash-based.
- **Money/costs:** `numeric(12,6)` USD. **Tokens:** `integer`/`bigint`.
- **Enums:** Postgres enums for closed sets that gate logic (action status, risk class);
  `text` + CHECK for sets likely to grow.
- **Migrations:** forward-only, reviewed, one logical change per migration; no
  `db push`-style auto schema mutation in production.
- **Vector columns:** `vector(D)` where D is fixed per embedding-model config; embedding
  model + dimension recorded on every row that stores a vector.

---

## 2. Domain map

~60 tables (PRD §139) grouped into 12 domains. Phase column = when first created.

| Domain | Tables | Phase |
|---|---|---|
| A. Identity & tenancy | organizations, users, memberships, membership_client_scopes, sessions, clients, sites, site_settings, feature_flags | 0 |
| B. Integrations | integrations, integration_tokens, wordpress_sites | 0–1 |
| C. Crawl & Digital Twin | crawl_runs, crawl_pages, pages, page_versions, page_metrics, page_scores, sitemaps | 1 |
| D. Search & analytics data | gsc_metrics, gsc_rollups, ga4_metrics, gtm_audits, keyword_imports, keywords, keyword_clusters, keyword_page_map | 2 |
| E. SERP & competitors | serp_queries, serp_snapshots, competitors, competitor_pages | 2–3, 10 |
| F. Knowledge & entities | entities, entity_relationships, business_facts, sources, claims | 6 |
| G. Opportunities & planning | opportunities, roadmaps, scoring_versions | 3 |
| H. Execution & safety | actions, action_patches, page_snapshots, executions, qa_runs, rollback_events | 4 |
| I. Content | content_briefs, content_drafts, content_reviews | 6 |
| J. Links & schema | internal_links, link_opportunities, schemas, schema_versions | 5 |
| K. Indexation & monitoring | index_checks, alerts, anomaly_baselines | 8 |
| L. AI visibility / authority | ai_queries, ai_visibility_runs, backlinks, brand_mentions | 9–10 |
| M. Learning & experiments | learning_records, experiments | 11–12 |
| N. Cost, audit, ops | llm_calls, cost_budgets, audit_logs, api_quota_usage | 0–2 |

---

## 3. Domain A — Identity & tenancy (Phase 0)

```text
organizations   id, name, slug, settings jsonb, created_at, updated_at
users           id, email (citext unique), password_hash, name, locale, mfa fields (later),
                is_platform_admin bool NOT NULL DEFAULT false,  -- platform ops, see note
                last_login_at, created_at, updated_at
memberships     id, organization_id, user_id, role (enum: agency_admin, seo_manager,
                content_editor, analyst, client_viewer),
                UNIQUE(organization_id, user_id)
membership_client_scopes
                id, membership_id FK→memberships ON DELETE CASCADE,
                client_id FK→clients ON DELETE CASCADE, created_at,
                UNIQUE(membership_id, client_id)
                -- rows restrict the membership to listed clients;
                -- no rows = access to all clients of the organization (role permitting)
sessions        id, user_id, token_hash, expires_at, ip, user_agent, created_at
clients         id, organization_id, name, status, industry, notes, created_at, updated_at
sites           id, organization_id, client_id, base_url, cms_type ('wordpress'),
                status, timezone, language, crawl_budget jsonb, created_at, updated_at
site_settings   id, site_id, organization_id, autopilot_mode (enum: off, review,
                safe_autopilot, full_autopilot),  -- DEFAULT 'review' (PRD §106 amended)
                graduation_policy jsonb,  -- configurable Safety Graduation Policy
                                          -- (min_green_actions: 20, require_all_qa: true,
                                          --  max_critical_incidents: 0,
                                          --  max_unresolved_rollback_failures: 0,
                                          --  require_explicit_opt_in: true) — defaults,
                                          -- NOT hardcoded; org-level defaults overridable
                graduated_at NULL, graduation_approved_by NULL,  -- audit of opt-in
                risk_overrides jsonb, model_router_overrides jsonb,
                ingestion_overrides jsonb,  -- per-site quota overrides (PRD §193)
                crawl_schedule jsonb, retention_overrides jsonb, updated_at
feature_flags   id, key, description, default_enabled bool,
                overrides jsonb  -- {org_id|site_id: bool}
```

Notes:
- **Platform administration is NOT an organization role.** `users.is_platform_admin`
  is the Phase-0 design (simplest secure option): it cannot be set through any API
  (migration/seed or manual, audited SQL only), it grants access exclusively to a
  separate platform-admin route group (ops dashboards, deletion requests,
  cross-tenant aggregates via the dedicated role), and every use is audit-logged.
  It does not bypass RLS on tenant data paths. Revisit (dedicated table + MFA
  requirement) before any additional platform operators are added.
- Role semantics and permission matrix: `SECURITY.md §RBAC`.

---

## 4. Domain B — Integrations (Phase 0 shell, Phase 1–2 providers)

```text
integrations        id, organization_id, client_id NULL, site_id NULL,
                    provider (text: 'wordpress','gsc','ga4','gtm','serp:<vendor>',…),
                    status (enum: connected, error, revoked, expired),
                    config jsonb (non-secret), last_verified_at, error_detail,
                    created_by, created_at, updated_at
integration_tokens  id, integration_id, organization_id,
                    ciphertext bytea, key_version int, algo text,   -- envelope encryption
                    token_kind (oauth_refresh | oauth_access | app_password | api_key),
                    expires_at NULL, rotated_at, created_at
wordpress_sites     id, site_id, organization_id, wp_url, plugin_version NULL,
                    wp_version, rest_available bool, plugin_available bool,
                    capabilities jsonb (detected: builders, seo_plugin, woocommerce…),
                    health_status, last_health_check_at
```

Rules: token plaintext never touches the database or logs (`SECURITY.md §Secrets`).
Revoking an integration destroys token rows (crypto-shredding via key deletion is a
later hardening step).

---

## 5. Domain C — Crawl & Digital Twin (Phase 1)

The Digital Twin is `pages` (head) + `page_versions` (content identity) + satellite
metric/score tables. PRD §20's ~50 attributes are split by provenance so each group has
its own freshness timestamp instead of one falsely-fresh blob.

```text
crawl_runs     id, site_id, organization_id, type (full | incremental),
               status (queued|running|completed|failed|cancelled),
               stats jsonb (fetched, changed, errors, rendered_count…),
               robots_snapshot text, started_at, finished_at, created_at
crawl_pages    id, crawl_run_id, site_id, organization_id, url, final_url,
               http_status, fetch_mode (http | rendered), content_hash,
               redirect_chain jsonb, headers jsonb, fetched_at, error text NULL
               -- raw per-fetch record; retention-limited (§15)

pages          id, site_id, organization_id, url (unique per site), wp_id NULL,
               content_type (page|post|cpt:<name>|category|…), template NULL,
               builder (gutenberg|elementor|classic|unknown) NULL,
               status (active|gone|redirected|excluded),
               current_version_id → page_versions,
               first_seen_at, last_crawled_at, last_changed_at,
               crawl_depth, in_sitemap bool, crawl_priority smallint
page_versions  id, page_id, site_id, organization_id,
               content_hash, heading_hash, metadata_hash, schema_hash, template_hash,
               title, meta_description, h1, headings jsonb, canonical, robots_meta,
               lang, hreflang jsonb, word_count,
               main_content_ref text,        -- object-storage key (extracted main content)
               images jsonb, internal_links jsonb, external_links jsonb,
               schema_raw_ref text NULL,     -- object-storage key
               embedding vector(D) NULL, embedding_model text NULL,
               captured_at
page_metrics   id, page_id, site_id, organization_id, source (gsc|ga4|crux|lighthouse),
               window (7|28|90|180|365 or date), metrics jsonb, computed_at
page_scores    id, page_id, site_id, organization_id, score_type (seo|aeo|geo|quality|
               internal_authority|freshness), value numeric, components jsonb,
               scoring_version text, computed_at        -- explainability: PRD §124
sitemaps       id, site_id, organization_id, url, type (index|urlset), status,
               url_count, last_fetched_at, issues jsonb
```

Indexes: `pages(site_id, url)` unique; `page_versions(page_id, captured_at desc)`;
hash lookup `page_versions(site_id, content_hash)`; vector index (HNSW) on embedding.

**Link data — single source of truth:** `page_versions.internal_links` /
`external_links` are the **immutable raw extraction** belonging to that page version
(what the crawler saw at capture time). The normalized `internal_links` table
(Domain J, Phase 5) is a **derived, queryable graph** materialized from the *current*
relevant page versions; it is fully rebuildable from page_versions at any time and is
refreshed when a page's current version changes. Engines query the derived graph;
history/diffing reads the raw per-version data. There are never two competing
authorities: raw = per-version truth, derived = current-graph projection.

---

## 6. Domain D — Search & analytics data (Phase 2)

```text
gsc_metrics     PARTITIONED BY RANGE (date), monthly partitions.
                site_id, organization_id, date, page_url_hash, page_url, query,
                device, country, clicks, impressions, ctr, position
                -- API row caps enforced at ingest; large sites → BigQuery path (flagged)
gsc_rollups     site_id, organization_id, window, dimension (page|query|page_query),
                key, clicks, impressions, ctr, position, trend jsonb, computed_at
                -- dashboards & engines read rollups, never raw
ga4_metrics     site_id, organization_id, date, landing_page, sessions, users,
                engagement jsonb, key_events jsonb, conversions numeric, revenue numeric
gtm_audits      id, site_id, organization_id, container_id, workspace, raw_ref text,
                findings jsonb, audited_at
keyword_imports id, site_id, organization_id, filename, storage_ref, row_count,
                status, mapping jsonb, imported_by, created_at
keywords        id, site_id, organization_id, keyword (normalized), volume, difficulty,
                cpc, locale, source (import|gsc), embedding vector(D) NULL,
                cluster_id NULL, intent (informational|commercial|transactional|
                navigational|local|unknown), intent_source (rule|embedding|llm),
                created_at, updated_at
keyword_clusters id, site_id, organization_id, label, primary_keyword_id,
                intent, method (lexical|embedding|serp|llm), confidence, created_at
keyword_page_map id, site_id, organization_id, keyword_id, page_id NULL,
                decision (primary|secondary|create_page|merge|no_action),
                decided_by (rule|llm|human), confidence, updated_at
```

---

## 7. Domain H — Execution & safety (Phase 4) — highest-stakes tables

```text
actions         id, action_uid text UNIQUE ('ACT-2026-000001'),
                site_id, client_id, organization_id,
                opportunity_id NULL, type (text: 'meta_description.update',
                'image_alt.add', 'schema.add', 'internal_link.fix', …),
                risk (enum: green, yellow, red),
                status (enum: draft, pending_approval, approved, queued, snapshotting,
                        preflight, executing, qa, committed, rolling_back,
                        rolled_back, rollback_failed, failed, cancelled, rejected),
                -- terminal semantics (EXECUTION-SAFETY.md §1): rolled_back = write
                -- occurred + successfully reverted; rollback_failed = write occurred,
                -- rollback did NOT restore state (triggers EXECUTION_FREEZE);
                -- failed = no production write was made (only valid use)
                target jsonb (page ids / wp ids / scope),
                summary text, rationale jsonb (evidence, expected impact),
                requested_by (system|user_id), approved_by NULL, approved_at NULL,
                batch_id NULL, idempotency_key text UNIQUE,
                created_at, updated_at
action_patches  id, action_id, organization_id, format (wp_meta|wp_content_blocks|
                schema_jsonld|redirect|…), patch jsonb,      -- structured, invertible
                inverse_patch jsonb NULL, preflight_result jsonb, created_at
page_snapshots  id, action_id NULL, page_id, site_id, organization_id,
                kind (pre_change|post_change|scheduled),
                tier (enum: lite, standard, enhanced),  -- EXECUTION-SAFETY.md §4
                wp_payload_ref,                          -- mandatory at every tier
                html_ref NULL, screenshot_desktop_ref NULL, screenshot_mobile_ref NULL,
                builder_payload_ref NULL,                -- enhanced tier
                metadata jsonb (headers, links, schema, hashes, metrics as per tier),
                storage_bytes, captured_at        -- refs are object-storage keys
executions      id, action_id, organization_id, attempt int, status,
                wp_response jsonb, started_at, finished_at, error text NULL
qa_runs         id, action_id, execution_id, organization_id,
                status (passed|failed|warning),
                checks jsonb ([{check, result, detail}...]),   -- PRD §109 checklist
                visual_diff jsonb NULL, started_at, finished_at
rollback_events id, action_id, organization_id, trigger (qa_failure|manual|guard),
                status (succeeded|failed), detail jsonb, restored_snapshot_id,
                created_at
```

State machine legality is enforced in code (`execution-engine`) and by a DB trigger
that rejects illegal `actions.status` transitions (belt and suspenders).
See `EXECUTION-SAFETY.md`.

---

## 8. Domain G — Opportunities (Phase 3)

```text
opportunities   id, site_id, client_id, organization_id,
                category (technical|content|ctr|cannibalization|linking|schema|aeo|geo),
                problem text, evidence jsonb (queries, metrics, URLs — machine-checkable),
                affected_page_ids uuid[], recommended_action jsonb,
                impact numeric, confidence numeric, business_value numeric,
                data_strength numeric, effort numeric, risk numeric,
                score numeric, scoring_version text,
                status (open|planned|actioned|dismissed|expired),
                estimated_cost jsonb NULL, created_at, updated_at
scoring_versions id, version text UNIQUE, formula jsonb (weights/components), active bool,
                notes, created_at         -- PRD §38: versioned scoring engine
roadmaps        id, site_id, organization_id, phases jsonb, generated_at,
                scoring_version, status
```

Every score persists its components + version — no unexplained numbers (PRD §124).

---

## 9. Domain N — Cost, audit, ops (Phase 0–2)

```text
llm_calls       id, organization_id, client_id NULL, site_id NULL,
                task (text: 'keyword.intent', 'content.brief', …), prompt_id,
                prompt_version, model_class (fast|balanced|strong), model (actual id),
                input_tokens, output_tokens, cached_tokens,
                estimated_cost, actual_cost, latency_ms,
                cache_status (hit|miss|bypass), escalation_count smallint,
                request_hash text,        -- namespaced cache key, see llm_cache
                input_hash text, output_hash text,   -- hashes only; NO raw text
                debug_capture_ref text NULL,  -- optional encrypted object-storage ref
                success bool, error_kind NULL, created_at
                PARTITIONED BY RANGE (created_at), monthly
                -- PRIVACY: llm_calls stores metadata, hashes, token counts, model,
                -- cost, latency, success/error, prompt_version — NEVER raw prompts
                -- or responses. Raw input/output capture for debugging/audit exists
                -- only when explicitly enabled per task/scope: encrypted object-
                -- storage artifact (redacted where possible), referenced by
                -- debug_capture_ref, short configurable retention (§12), purgeable
                -- via the legal/security deletion path.
llm_cache       cache_key PK,             -- hash(cache_namespace + model +
                                          --      prompt_version + canonical_input)
                cache_namespace text,     -- 'org:<id>' | 'site:<id>' | 'global'
                response jsonb, model, prompt_version,
                created_at, last_hit_at, hit_count
                -- TENANT SAFETY: every task whose input contains organization/
                -- client/site data MUST use a tenant namespace; identical canonical
                -- inputs from different tenants therefore never collide. The
                -- 'global' namespace is allowed ONLY for tasks explicitly
                -- classified non-tenant/public in the prompt registry
                -- (AI-COST-ARCHITECTURE.md §5.1). Tenant-namespaced entries are
                -- deleted with their tenant.
cost_budgets    id, organization_id, client_id NULL, site_id NULL,
                scope (daily|monthly|per_task_type), task_type NULL,
                limit_usd numeric, hard_stop bool, alert_threshold numeric,
                current_spend cached via rollup, updated_at
audit_logs      id, organization_id, actor (user_id|'system'|'worker:<queue>'),
                action text, target_type, target_id, before jsonb NULL, after jsonb NULL,
                source (ui|api|worker|wp_plugin), ip inet NULL, result (ok|denied|error),
                created_at    -- append-only; no UPDATE/DELETE grants
api_quota_usage id, provider, organization_id NULL, window_start, requests int,
                quota_limit int, throttled_count int
```

---

## 10. Domains E, F, I, J, K, L, M (later phases — shape only)

These are specified at migration time in their phase; the PRD-listed tables map as:

- **SERP/competitors:** `serp_queries` (tracked query set per site), `serp_snapshots`
  (provider payload ref + parsed features, time-series), `competitors`,
  `competitor_pages` (hash + diff based change radar, PRD §35).
- **Knowledge:** `entities` (+ stable entity URIs, PRD §65), `entity_relationships`,
  `business_facts` (typed facts, `UNKNOWN` is representable — PRD §45), `sources`,
  `claims` (claim ledger with verified_at + pages_using_claim, PRD §51).
- **Content:** `content_briefs`, `content_drafts` (versioned, storage refs, commodity
  score), `content_reviews` (human/system review gates, PRD §52).
- **Links/schema:** `internal_links` — the normalized edge list **derived from the
  current page_versions** (see §5: rebuildable projection, not a second source of
  truth), `link_opportunities`, `schemas` + `schema_versions` (per-page JSON-LD with
  validation results).
- **Monitoring:** `index_checks` (URL Inspection results), `alerts`,
  `anomaly_baselines` (PRD §115 baselines per metric).
- **AI visibility:** `ai_queries` (fixed prompt set, versioned), `ai_visibility_runs`
  (provider, model, brand/competitor mentions, citations — labeled synthetic).
- **Learning:** `learning_records` (action fingerprint → before/after outcome; the
  cross-client view exposes only anonymized aggregates), `experiments` (PRD §101).
- **Backlinks/mentions:** `backlinks`, `brand_mentions` (provider-abstracted).

---

## 11. Vector strategy

- One embedding model (configurable) per deployment at a time; dimension fixed in config.
  Re-embedding on model change is an explicit backfill job, tracked per row via
  `embedding_model`.
- Embeddings exist for: page main content (per `content_hash` — computed once per hash,
  PRD §10), keywords, entities (later), link-candidate paragraphs (later).
- HNSW indexes; similarity queries always filtered by `site_id` first.

## 12. Data lifecycle & retention (PRD §192 — approved 2026-08-31)

All periods below are **defaults, configurable** globally (env/org settings) and per
site (`site_settings.retention_overrides`). Retention jobs are ordinary scheduled
workers; every deletion is audited.

| Artifact | Default retention |
|---|---|
| crawl_pages (raw fetch rows) | 90 days (aggregates live on in pages/page_versions) |
| rendered HTML (object storage, incl. main_content refs) | follows owning page_version / snapshot |
| page_versions | keep all versions for pages with actions; else last N=10 |
| screenshots (desktop/mobile) | 12 months, then cold storage/delete |
| page_snapshots (WP payloads, HTML) | 12 months, then cold storage/delete; retained while any related action is contested |
| application logs | 30–90 days (ops-configured) |
| audit_logs | 7 years, append-only |
| serp_snapshots raw payloads | 6 months; parsed features indefinitely |
| analytics aggregates (gsc_rollups, ga4 rollups, llm cost rollups) | indefinitely |
| llm_calls rows (metadata/hashes/costs only — no raw text) | 13 months (partition drop); rollups indefinitely |
| LLM raw debug captures (encrypted object storage, opt-in only) | 30 days default (configurable, shorter-biased); purgeable via legal/security deletion |
| gsc_metrics raw | 16 months (Google's own horizon); rollups indefinitely |

**Deleted client/site:** soft-delete with a 30-day grace period (restorable, hidden
from UI), then full purge: content, page versions, snapshots, screenshots, vectors,
metrics, integration tokens (crypto-shred), object-storage prefixes. Audit-log rows
referencing the tenant remain (append-only), with content payloads already external
to them by design.

**Legal/security deletion:** an admin-only, audited deletion capability exists for
legal requests or security incidents — immediate purge of the targeted artifacts
(bypassing grace periods), including crypto-shredding of tokens and object-storage
deletion. Surfaced via the admin API (API-CONTRACTS.md §2, data lifecycle group);
enforcement details in SECURITY.md §9.

## 13. Tenant-isolation test hooks

`packages/database` ships test utilities that: create two orgs, seed identical data,
run every repository method under org A's context, and assert zero rows from org B —
plus raw-SQL RLS probes. These run in CI from Phase 0 onward (see `TESTING.md`).
