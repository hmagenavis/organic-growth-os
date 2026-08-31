# ADR-0011: Adapter interfaces for every external provider

Status: Accepted (2026-08-31 — accepted with the Phase 0 go decision)

## Context
PRD §15: every integration must be an adapter; the core must not depend on
any specific provider (SERP vendors churn, LLM vendors churn, backlink data is
commodity, storage is commodity).

## Decision
`packages/contracts` defines interfaces (`CmsConnector`, `SeoMetadataProvider`,
`SearchConsoleProvider`, `AnalyticsProvider`, `TagManagerProvider`, `SerpProvider`,
`BacklinkProvider`, `LLMProvider`, `EmbeddingProvider`, `StorageProvider`, …);
`packages/integrations` hosts implementations and the composition root that selects
providers from config. Engines import interfaces only. Adapters normalize errors to a
typed taxonomy (auth/quota/unavailable/invalid) consumed by the central quota manager
(retry/backoff/priority, PRD §163). Contract tests with recorded fixtures pin
external API shapes per adapter.

## Alternatives considered
- Direct SDK usage in engines: lock-in, untestable, quota chaos. Rejected.

## Consequences
- Adding a provider = new adapter + fixtures, zero engine changes.
- Slight indirection cost, paid once per provider category.
