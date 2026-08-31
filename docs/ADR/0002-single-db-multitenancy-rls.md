# ADR-0002: Single-DB multi-tenancy — scoped repositories + Postgres RLS

Status: Accepted (2026-08-31 — accepted with the Phase 0 go decision)

## Context
Multi-tenant isolation is mandatory (PRD §140) with hierarchy org → client → site.
Options: (a) database-per-tenant, (b) schema-per-tenant, (c) shared schema with
tenancy columns. Tenants are agencies with many small/medium clients; cross-tenant
aggregated learning (PRD §128) requires querying across tenants in a controlled way.

## Decision
Shared schema (c) on a single PostgreSQL cluster, with **two enforcement layers**:
1. Application: repositories in `packages/database` require a `TenantContext`; no
   exported unscoped query path for tenant tables.
2. Database: Row-Level Security on every tenant-scoped table keyed on
   `current_setting('app.current_org_id', true)`, established with
   **transaction-local state only** (`SET LOCAL` / `set_config(..., true)` inside
   the transaction — session-level `SET` is banned because pooled connections can
   leak it across checkouts); runtime DB role cannot bypass RLS. Workers derive
   tenant context from trusted persisted run/action rows, never from raw queue
   payload fields. Cross-tenant aggregation goes through a dedicated role and
   anonymized views only.
Tenancy columns (`organization_id`, plus `client_id`/`site_id` where applicable) are
denormalized onto every scoped table.

## Alternatives considered
- DB/schema-per-tenant: strongest isolation but kills cross-client learning queries,
  multiplies migration surface, complicates pooling — over-engineering for MVP scale.
- App-layer scoping only: one missed `where` clause = breach; rejected. RLS costs
  little and converts bugs into empty result sets.

## Consequences
- Every connection/job must establish tenant context; the database package owns this.
- Slight query overhead from RLS; acceptable, and indexes lead with tenancy columns.
- Migration to schema-per-tenant later remains possible (tenancy columns make rows
  portable) if an enterprise customer demands it.
