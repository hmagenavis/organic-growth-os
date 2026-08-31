# AI-COST-ARCHITECTURE.md
# Organic Growth OS — AI / Token Cost Architecture

Version: 1.0 (planning baseline)
Principle: token efficiency is an architectural property, not an optimization pass
(PRD §4, §186). Deterministic code, SQL, parsers, hashes and embeddings run FIRST;
LLMs see only the filtered remainder, with minimal context, under enforced budgets.

---

## 1. The funnel (order is mandatory)

```text
Stage 0  Cheap facts        HTTP status, parser, regex, schema validator, SQL
Stage 1  Change detection   content/heading/metadata/schema/template hashes; diffs
Stage 2  Statistics         SQL aggregates, trends, CTR gaps, thresholds
Stage 3  Embeddings         similarity, clustering, candidate generation (cached)
Stage 4  Context assembly   capsules + Top-K retrieval (small K)
Stage 5  LLM (leaf)         structured, budgeted, cached, routed by model class
```

A task may only reach stage 5 if stages 0–4 could not resolve it deterministically.
Examples pinned by PRD §4: 404s, missing H1, canonical, duplicate titles, broken
links, schema syntax, first-pass page similarity → **never** an LLM call.

## 2. The `llm` package — single chokepoint

No engine calls an LLM provider directly. Everything goes through `packages/llm`:

```text
executeLlmTask(task) →
  1. resolve prompt (prompt_id + version) and output schema
  2. assemble context (capsules, Top-K) → estimate input tokens
  3. BUDGET CHECK (per task / site / client / day / month)
  4. cache lookup: hash(cache_namespace + model + prompt_version + canonical input)
     — namespace is tenant-scoped by default; 'global' only for tasks explicitly
       classified non-tenant (§5.1)
  5. route model class (fast | balanced | strong) via config
  6. call provider adapter; validate output against JSON schema
  7. on invalid JSON: one repair retry, then fail (no prose parsing)
  8. log llm_calls row (metadata, hashes, tokens, cost, cache_status, latency,
     escalations — never raw prompt/response text; see §13)
```

Every request carries (PRD §6): `estimated_input_tokens`, `max_input_tokens`,
`max_output_tokens`, `model_class`, `expected_cost`; the response records
`actual_cost`, `cache_status`, `escalation_count`.

## 3. Model router (PRD §7)

- Three classes: `FAST`, `BALANCED`, `STRONG`. Mapping to concrete model IDs is
  **configuration** (env defaults + DB overrides per org/site), never hardcoded.
- Task → class defaults live in a versioned registry alongside prompts, e.g.:
  classification/extraction/tagging → FAST; keyword intent, briefs, link judgment →
  BALANCED; strategy, ambiguous cannibalization, root-cause → STRONG.
- Escalation ladder on low confidence or budget pressure (PRD §148):
  1. shrink context, 2. use cached summary, 3. cheaper model,
  4. escalate to stronger model only if confidence still below threshold
  (max 1 escalation; max 2 retries; hard caps configurable — PRD §149).

## 4. Budgets & guardrails (PRD §6, §148, §160)

- `cost_budgets` rows define daily / monthly / per-client / per-task-type limits.
- Soft threshold → alert; hard limit → task queue pauses LLM-class jobs for that scope
  (deterministic jobs continue). Nothing silently overspends.
- Pre-flight estimation: tasks exceeding `max_input_tokens` are rejected back to the
  planner to shrink context — never truncated blindly mid-prompt.
- Cost dashboard (agency admin): today / month / per client / per module / per action
  type / projected month, straight from `llm_calls` rollups.
- Upstream volume control: configurable ingestion & quota limits (crawl URLs/depth/
  concurrency, keyword import rows, GSC row caps, BigQuery switch-over recommendation)
  bound how much data can ever become LLM-work — PRD §193, ARCHITECTURE.md §7.1.
- LLM input/output records (`llm_calls`) are retained 13 months raw, rollups
  indefinitely — configurable per DATA-MODEL.md §12 (PRD §192).

## 5. Caching layers

| Layer | Key | Table/Store |
|---|---|---|
| LLM response cache | hash(cache_namespace + model + prompt_version + canonical input) | `llm_cache` (PRD §8) |
| Embedding cache | content_hash + embedding_model | vectors on `page_versions` etc. (PRD §10) |
| Capsule cache | input-hash of capsule sources | capsule tables, rebuilt only on change |
| Provider payloads | provider + request fingerprint | object storage + DB refs (SERP snapshots etc.) |

### 5.1 Tenant-safe cache namespaces (binding rule)

Tenant-specific LLM responses must never be shared across tenants merely because
canonical inputs happen to hash identically. Therefore:

- Every task whose input contains organization/client/site data uses a **tenant
  namespace** (`org:<id>` or `site:<id>`) in its cache key. This is the default for
  all tasks.
- The `global` namespace is permitted only for tasks **explicitly classified
  non-tenant/public in the prompt registry** (e.g., generic SERP-feature
  classification of public data) — the classification is a reviewed property of the
  prompt registry entry, not a per-call decision.
- Tenant-namespaced cache entries are deleted with their tenant (retention/offboarding,
  DATA-MODEL.md §12; enforcement in SECURITY.md).

Prompt-version bump intentionally invalidates the LLM cache for that task only.
Provider-side prompt caching (cached input tokens) is additionally used where the
provider supports it; `cached_tokens` is logged per call.

## 6. Content hashing & diff-based analysis (PRD §9, §11)

- Five hashes per page version: `content_hash`, `heading_hash`, `metadata_hash`,
  `schema_hash`, `template_hash`. Unchanged hash ⇒ skip that analysis family entirely.
- When content changes, compute a structural diff (block-level) and analyze
  **diff + relevant context**, not the full document. Full re-analysis only when the
  diff exceeds a configurable ratio (e.g. >40% of blocks changed).

## 7. Boilerplate removal (PRD §12)

Extraction (in `crawler-core`) strips nav, footer, cookie banners, sidebars, repeated
global components using DOM heuristics + cross-page template detection
(`template_hash` = hash of repeated structural skeleton). Only main content is stored
as analyzable text and only main content ever reaches an LLM.

## 8. Hierarchical Context System (PRD §5)

Capsules are **materialized, versioned, token-bounded summaries** stored in the DB:

| Level | Rebuild trigger | Token budget (default) |
|---|---|---|
| L1 Organization | business facts change | ≤ 600 |
| L2 Site | site structure/metrics shift | ≤ 800 |
| L3 Topic (per cluster) | cluster membership/SERP change | ≤ 500 |
| L4 Page (per URL) | page content_hash change | ≤ 400 |
| L5 Task | assembled per task | task-specific cap |

Task assembly picks the minimal set (e.g., title rewrite = L1 brand rules + L4 page
capsule + top queries — not the article body; PRD §5 example).

### 8.1 Deterministic capsule generation first (binding pipeline)

Capsules are NOT LLM products by default:

```text
structured facts / SQL aggregates / extraction
  → deterministic capsule builder (templated serialization of typed fields)
  → within token budget AND no free-text compression needed?  → DONE ($0 tokens)
  → else: FAST-class LLM semantic compression of the overflow only
  → cache by input hash (computed once per hash, either way)
```

Metric/structural capsules (site architecture stats, page metrics, cluster
membership, coverage tables) are fully deterministic and cost **zero LLM tokens**.
The FAST LLM path exists only for genuine semantic compression (e.g., summarizing
long free-text business descriptions or heterogeneous content into the L1/L4 budget)
and only for the fields that need it. Expected outcome: the large majority of capsule
builds spend no tokens, and capsule token spend appears in KPIs as its own task type
(`capsule.compress`) so drift is visible.

## 9. Retrieval limits (PRD §13)

Default Top-K = 5–10 chunks; K may grow only via the escalation ladder when confidence
is low, never "just in case". Retrieval requests log K and total context tokens.

## 10. Batching & scheduling

- LLM-class jobs are batched by task type (e.g., 50 keyword-intent items per call where
  the schema supports arrays) to amortize prompt overhead.
- Non-urgent LLM work (capsule refresh, bulk classification) runs on off-peak schedules
  and lower queue priority than user-facing requests.
- Provider batch APIs are preferred for non-interactive bulk work **when the
  provider's configuration marks them cheaper**. Actual discounts, per-token prices,
  and capabilities (batch, prompt caching, structured outputs) live in a
  **provider capability/pricing configuration** (versioned config consumed by the
  router and cost estimator) — never hardcoded assumptions about specific discount
  percentages, which change over time.

## 11. Token KPIs (PRD §182)

Tracked as first-class metrics from Phase 2 onward: tokens per analyzed page, per
content optimization, per opportunity, per client per month; plus cache hit rate,
cost per successful action, and **capsule builds served at $0** (deterministic path,
§8.1) vs builds needing LLM compression. Target trends: **cost per page decreases**
as hash/cache coverage grows, and the deterministic-capsule share increases toward
the large majority of builds.

## 12. Top AI-cost risks & mitigations

| Risk | Mitigation |
|---|---|
| Re-analyzing unchanged content | hash gates at every pipeline entrance |
| Full-site context stuffing | capsules + hard `max_input_tokens` per task |
| Per-keyword LLM classification | lexical → embedding → SERP overlap first; LLM only for ambiguous clusters (PRD §30) |
| Retry/escalation loops | max retries 2, max escalation 1, depth 2 (PRD §149) |
| Cache-defeating prompt churn | versioned prompt registry; version bumps are reviewed |
| Silent budget overrun | hard budget stops + pause + alert |
| Strong-model overuse | router defaults + per-class spend visibility per module |
| Embedding churn on recrawl | embeddings keyed to content_hash, computed once |

## 13. LLM logging & privacy

`llm_calls` stores **metadata only**: task, prompt_id/version, model class + model,
token counts (input/output/cached), estimated/actual cost, latency, cache status,
escalation count, success/error kind, and input/output **hashes**. Raw prompts and
responses are never written to this table.

Raw input/output capture exists only for debugging/audit, and only when explicitly
enabled (per task type and/or tenant scope): the artifact goes to **encrypted object
storage** (secrets/PII redacted where possible), referenced by
`llm_calls.debug_capture_ref`, with a short configurable retention (default 30 days,
DATA-MODEL.md §12) and eligibility for the legal/security purge path (SECURITY.md §9).
