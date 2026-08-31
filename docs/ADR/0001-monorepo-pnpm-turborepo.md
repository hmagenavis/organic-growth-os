# ADR-0001: Monorepo with pnpm + Turborepo

Status: Accepted (2026-08-31 — approved incl. reduced MVP starter package set)

## Context
The system spans a dashboard, API, workers, ~10 growing domain packages, shared
contracts, and a WordPress plugin. Contracts (Zod schemas, adapter interfaces) must be
shared with zero drift between apps. PRD §132 recommends monorepo + pnpm + Turborepo.

## Decision
Single monorepo: pnpm workspaces for linking/installs, Turborepo for task graph and
caching (build/lint/test per package, affected-only in CI). The WordPress plugin (PHP)
lives in the same repo (`wordpress-plugin/`) outside the TS task graph, with its own
lint/test scripts wired into CI.

## Alternatives considered
- Polyrepo: contract drift, versioning overhead, cross-cutting changes become
  multi-repo PRs — rejected for a small team building tightly coupled modules.
- Nx: more machinery than needed; Turborepo is sufficient and simpler.

## Consequences
- One version of every dependency; atomic cross-cutting changes; shared CI cache.
- Requires the package dependency-direction rule (ARCHITECTURE.md §4) to be enforced
  by lint tooling so the monorepo doesn't become a ball of mud.
