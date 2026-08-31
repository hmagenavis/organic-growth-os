# ADR-0007: LLM provider abstraction + configurable FAST/BALANCED/STRONG router

Status: Accepted (2026-08-31 — accepted with the Phase 0 go decision)

## Context
PRD §7 forbids using the strongest model for everything and mandates a configurable
three-class router. PRD §15 requires provider abstraction. Model landscapes shift
faster than release cycles; model choice must be ops-config, not code.

## Decision
`packages/llm` exposes `executeLlmTask()` as the single entry point. Providers
implement `LLMProvider`/`EmbeddingProvider` adapters. Tasks declare a **model class**
(FAST/BALANCED/STRONG), never a model ID. Class → model-ID mapping resolves from
config: env defaults (`MODEL_FAST`, `MODEL_BALANCED`, `MODEL_STRONG`) overridable per
org/site in DB (`site_settings.model_router_overrides`). Task → class defaults live
in the versioned prompt registry. Escalation between classes follows the ladder in
AI-COST-ARCHITECTURE.md §3 with hard caps (PRD §148–149).

## Alternatives considered
- Direct SDK calls per engine: unmeterable, uncacheable, unbudgetable — prohibited.
- LiteLLM-style proxy service: extra hop and infra; the adapter layer already gives
  us provider portability in-process.

## Consequences
- Swapping providers or re-tiering models is a config change with an audit trail.
- All cost/budget/cache logic concentrates in one package — one place to test.
