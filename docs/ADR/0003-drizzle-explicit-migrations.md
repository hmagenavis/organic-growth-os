# ADR-0003: Drizzle ORM with explicit, forward-only SQL migrations

Status: Accepted (2026-08-31 — accepted with the Phase 0 go decision)

## Context
PRD §136 mandates Postgres + pgvector, an ORM with explicit migrations, and forbids
auto schema mutation in production. We need typed queries, RLS compatibility, raw SQL
access for analytics/rollups, and pgvector support.

## Decision
Drizzle ORM. Schema defined in TypeScript (`packages/database`); migrations are
generated, **hand-reviewed SQL files**, forward-only, applied by a dedicated migration
role via CI/CD step — never `push`-style sync, never at app startup in production.
Data backfills are separate, idempotent migration scripts.

## Alternatives considered
- Prisma: weaker raw-SQL ergonomics, historical friction with RLS/session settings and
  pgvector; heavier runtime. Rejected.
- Kysely + separate migrator: viable, but Drizzle gives schema-as-source-of-truth plus
  comparable SQL transparency with less assembly.

## Consequences
- RLS policies and triggers are written as raw SQL inside migration files (Drizzle
  doesn't model them) — a migration review checklist covers them.
- Rollbacks are roll-forward fixes; destructive migrations require an explicit
  two-step (deploy-safe) pattern.
