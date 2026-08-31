# ADR-0010: WordPress connector plugin as phased safety bridge (read-only v1)

Status: Accepted (2026-08-31 — phased delivery approved; Phase 1 connector READ ONLY,
write capabilities only with Safe Execution phases)

## Context
PRD §16 specifies an OrganicOS plugin covering auth, content, snapshots, rollback,
redirects, SEO plugins, builders, cache invalidation. Core WP REST alone can't
provide reliable snapshots/restore, builder detection, or targeted cache purge. But a
full-featured plugin on day one is a large security surface and delivery risk on
third-party production sites.

## Decision
Ship the plugin in phased builds:
- **v1 (Phase 1): read-only.** `/health`, `/capabilities`, `/inventory`,
  `/content/:id`. HMAC-signed requests + application-password auth. No write code
  compiled in.
- **v2 (Phase 4): write bridge.** `/snapshot`, `/apply` (idempotent), `/restore`,
  `/cache/invalidate`, scoped to the action types Phase 4 supports (meta, ALT,
  additive schema, link fixes).
- **v3+ (Phase 7+):** SEO-plugin adapters deepen, builder adapters (Elementor) only
  with dedicated safety work. Blind builder-JSON overwrite is rejected at preflight
  (PRD §18).
Platform degrades gracefully to core REST when the plugin is absent (reduced
capability, surfaced to the user).

## Alternatives considered
- REST-only forever: no reliable restore or builder awareness → unsafe execution.
- Full plugin up front: violates least-privilege and MVP discipline.

## Consequences
- Plugin versioning/compatibility matrix becomes part of contract testing (wp-env
  matrix, TESTING.md §5).
- Write capability is provably absent from customer sites until Phase 4 ships.
