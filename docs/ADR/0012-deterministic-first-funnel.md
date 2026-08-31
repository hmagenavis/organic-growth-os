# ADR-0012: Deterministic-first analysis funnel; LLM as filtered leaf

Status: Accepted (2026-08-31 — accepted with the Phase 0 go decision)

## Context
PRD §4, §30, §60, §110, §186: anything solvable by code/SQL/parsers/embeddings must
not reach an LLM; LLM handles only semantic judgment on pre-filtered candidates.

## Decision
Every analysis pipeline is structured as the mandatory funnel
(AI-COST-ARCHITECTURE.md §1): deterministic facts → hash/diff gates → SQL statistics
→ embeddings → minimal context assembly → structured LLM leaf. Concretely pinned:
- Technical audit (Phase 1): 100% deterministic, zero LLM.
- Keyword clustering: lexical → embeddings → SERP overlap → LLM only for ambiguous
  clusters (PRD §30).
- Internal linking: candidate detection → embedding similarity → graph relevance →
  anchor/existing checks → LLM only if ambiguous (PRD §60).
- Visual QA: pixel/layout diff first; LLM vision only on flagged anomalies (§110).
- Page similarity first pass: hashes/embeddings, never LLM.
Pipeline stages log what they filtered, so the funnel's efficiency is measurable
(candidates in → LLM calls out).

## Consequences
- Engines are mostly ordinary testable code; LLM behavior is isolated and mockable.
- Unit economics improve as caches fill (PRD §182 KPI: cost per client declines).
