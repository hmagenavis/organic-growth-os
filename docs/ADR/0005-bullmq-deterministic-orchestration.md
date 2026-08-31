# ADR-0005: BullMQ job orchestration; no LLM-driven workflows

Status: Accepted (2026-08-31 — accepted with the Phase 0 go decision)

## Context
PRD §137 mandates Redis + BullMQ. PRD §3.1/§144 mandate deterministic orchestration:
LLMs must never decide control flow. Long pipelines (crawl → analyze → embed) need
fan-out, retries, rate limiting, and idempotency (PRD §162).

## Decision
BullMQ on Redis. Queue groups: crawl, analyze, embed, llm, ingest, monitor, report
(+ execute/qa from Phase 4). Orchestration pattern: every long-running process is a
persisted **run row** in Postgres (source of truth for state) + BullMQ jobs
(execution vehicle); BullMQ Flows model parent/child fan-out. Job payloads carry
**IDs/references and minimal routing metadata only** (never secrets, tokens, full
HTML, large content, or full LLM prompts) plus an idempotency key; handlers are
idempotent and derive their authoritative `TenantContext` from the persisted
run/action row the payload references (SECURITY.md §4). Postgres, not Redis, is
authoritative — Redis loss must be recoverable by re-enqueueing from run state.
Scheduling via BullMQ repeatable jobs.

## Alternatives considered
- Temporal: superb determinism guarantees but an extra stateful cluster to operate;
  over-engineering at MVP scale. Re-evaluate if workflow complexity outgrows
  runs+flows.
- pg-boss (Postgres-only queue): fewer moving parts, but weaker rate limiting/
  concurrency controls needed by the crawler; Redis also serves rate limiters.
- Agentic/LLM orchestration: prohibited by PRD.

## Consequences
- Redis is infrastructure, not a datastore: nothing in Redis is unrecoverable.
- A small `runs` convention (status, stats, resumability) is implemented once and
  reused by crawl/ingest/execute pipelines.
