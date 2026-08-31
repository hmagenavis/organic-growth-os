# ADR-0008: Token budgets, LLM cache, content hashing and diffs as infrastructure

Status: Accepted (2026-08-31 — accepted with the Phase 0 go decision)

## Context
PRD §4/§186 make token efficiency an architectural principle. PRD §6, §8–§13 specify
budget manager, response cache, content hashing, embedding cache, diff analysis,
boilerplate removal and retrieval limits. Retrofitting these is impossible — every
engine must be built assuming they exist.

## Decision
Build them as Phase-2 infrastructure inside `packages/llm` + `packages/database`,
before any engine that consumes LLMs:
- `llm_calls` (metered log, partitioned; metadata/hashes only — no raw text) +
  `llm_cache` (content-addressed by hash(cache_namespace + model + prompt_version +
  canonical input); tenant-namespaced by default, `global` only for registry-
  classified public tasks) + `cost_budgets` (hard stops).
- Five content hashes per page version, computed at crawl time (Phase 1), gating
  every downstream analysis.
- Embeddings keyed by content_hash + model; computed once.
- Capsule system (materialized L1–L5 context) with token-bounded budgets.
- Prompt registry: prompt_id, version, model_class, output schema — versioned, so
  cache invalidation is intentional.

## Alternatives considered
- "Optimize later": rejected; PRD explicitly forbids it and unit economics are the
  product moat (PRD §182–183).
- External LLM-ops SaaS for metering: data residency + dependency for a core
  competency; rejected for MVP.

## Consequences
- Phase ordering: hashing exists before analysis, budgets exist before the first
  LLM call.
- Every LLM feature PR must state its task's model class, budget, and cache behavior
  (cost review gate, PRD §0).
