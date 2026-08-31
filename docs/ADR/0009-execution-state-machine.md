# ADR-0009: Safe execution as a persisted state machine with snapshots & rollback

Status: Accepted (2026-08-31 — accepted with the Phase 0 go decision)

## Context
PRD §103–§113, §188: every production change must pass Action → Risk → Snapshot →
Patch → Preflight → Execute → QA → Commit/Rollback, with canary batching, automatic
rollback and full auditability. This is the highest-stakes subsystem — it can break
customer sites.

## Decision
Model every change as an `actions` row with an explicit status enum (including the
persisted `rolling_back` state and the distinct terminals `rolled_back`,
`rollback_failed`, `failed` — exact semantics in EXECUTION-SAFETY.md §1; a
`rollback_failed` terminal triggers site-wide `EXECUTION_FREEZE`) and a legal
transition table, enforced in `execution-engine` **and** by a DB trigger. Patches are
typed, structured, and invertible where derivable (`inverse_patch`); snapshots are
immutable object-storage artifacts captured before any write, **tiered**
(LITE/STANDARD/ENHANCED) by a platform-defined per-action-type minimum that safety
policy may raise but never lower (EXECUTION-SAFETY.md §4), and validated for
tier-completeness. Risk classification is a deterministic rule engine
(GREEN/YELLOW/RED) over action type + scope — never an LLM output. QA runs a
deterministic **required-check registry per action type** (not the full suite for
every change; expensive performance checks only where plausibly relevant or sampled —
EXECUTION-SAFETY.md §9); critical failure triggers automatic rollback, verified by
hash comparison against the pre-change snapshot. Preflight re-checks that the
target's current content hash matches plan-time hash (stale-plan guard). Batches
execute as canaries (5→10→50→rest). Per-site and global kill switches park work
without loss. The write path (`execute`/`qa` queues, plugin write endpoints) does not
exist in the codebase before Phase 4.

## Alternatives considered
- Direct writes with undo-log only: no preflight, no risk gating — violates PRD §188.
- LLM-judged safety: non-deterministic gatekeeping over destructive operations;
  prohibited. LLM vision assists visual QA only after deterministic diff flags an
  anomaly (PRD §110).

## Consequences
- Execution throughput is deliberately bounded by QA; that's the product's moat
  (verified autonomous execution, PRD §183), not a limitation.
- Rollback-failure is a designed-for scenario: site-wide freeze + human escalation.
