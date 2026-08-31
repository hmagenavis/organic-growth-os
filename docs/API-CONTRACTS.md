# API-CONTRACTS.md
# Organic Growth OS — API & Module Contracts

Version: 1.0 (planning baseline)
Style: REST, OpenAPI 3.1 generated from Zod schemas in `packages/contracts` (ADR-0004)
Consumers: `apps/web` (primary), future public API (same surface, feature-flagged)

---

## 1. Global conventions

- **Base path:** `/v1`. Breaking changes → `/v2`; additive changes are not versioned.
- **Auth:** session cookie (`__Host-` prefixed, HttpOnly, SameSite=Lax) + CSRF token
  header for mutating requests. Details: `SECURITY.md`.
- **Tenancy:** organization is bound to the session. Client/site scoping is explicit in
  the path (`/v1/sites/:siteId/...`) and validated against membership + RBAC. IDs from
  another tenant return **404, never 403** (no existence leakage).
- **Content type:** `application/json; charset=utf-8`. File uploads: multipart.
- **Errors (RFC 9457 problem+json):**

```json
{
  "type": "https://errors.organic-os.dev/validation",
  "title": "Validation failed",
  "status": 400,
  "detail": "keyword file exceeds 50,000 rows",
  "instance": "/v1/sites/123/keyword-imports",
  "errors": [{ "path": "file", "message": "..." }],
  "requestId": "req_..."
}
```

- **Pagination:** cursor-based: `?limit=50&cursor=...` → `{ items, nextCursor|null }`.
  No offset pagination on large tables.
- **Idempotency:** all POSTs that create jobs/actions accept `Idempotency-Key` header;
  the key is persisted and replays return the original result (PRD §162).
- **Rate limiting:** per-session and per-org token buckets; `429` with `Retry-After`.
- **Long-running work:** POST returns `202` + `{ jobId }`; progress via
  `GET /v1/jobs/:jobId` (polling in MVP; SSE later). No synchronous heavy work (PRD §161).
- **Estimates are labeled:** any forecast field is nested under `estimate: {...,
  "isEstimate": true }` — the contract enforces PRD §40/§102 honesty.

---

## 2. Endpoint groups by phase

### Phase 0 — Identity, tenancy, admin

```text
POST   /v1/auth/login                 email+password → session cookie
POST   /v1/auth/logout
GET    /v1/auth/me                    user + memberships + role
POST   /v1/organizations              (bootstrap/super-admin flow)
GET    /v1/organizations/current
PATCH  /v1/organizations/current
GET    /v1/clients                    list (role-filtered)
POST   /v1/clients
GET    /v1/clients/:clientId
PATCH  /v1/clients/:clientId
DELETE /v1/clients/:clientId          soft-archive
GET    /v1/clients/:clientId/sites
POST   /v1/clients/:clientId/sites
GET    /v1/sites/:siteId
PATCH  /v1/sites/:siteId              settings incl. autopilot mode (RBAC-gated)
GET    /v1/users /v1/users/:id        membership management (admin)
POST   /v1/memberships                invite/assign role
GET    /v1/audit-logs                 filterable, admin only
GET    /v1/jobs/:jobId                generic job status
GET    /v1/feature-flags              effective flags for session
```

### Phase 1 — WordPress connection, crawling, Digital Twin (read-only)

```text
POST   /v1/sites/:siteId/integrations/wordpress     connect (URL + app password)
GET    /v1/sites/:siteId/integrations               list + health
POST   /v1/integrations/:id/verify                  re-check health
DELETE /v1/integrations/:id                         revoke (destroys tokens)

POST   /v1/sites/:siteId/crawls          body: {type: full|incremental} → 202 {jobId}
GET    /v1/sites/:siteId/crawls          run history + stats
GET    /v1/sites/:siteId/crawls/:runId

GET    /v1/sites/:siteId/pages           filter: type, status, issues, q; paginated
GET    /v1/pages/:pageId                 twin detail (versions, hashes, links, issues)
GET    /v1/pages/:pageId/versions
GET    /v1/sites/:siteId/audit           technical audit summary (deterministic findings)
GET    /v1/sites/:siteId/audit/issues    paginated issue list w/ evidence
GET    /v1/sites/:siteId/sitemaps
```

### Phase 2 — Google intelligence & keywords

```text
POST   /v1/sites/:siteId/integrations/google        OAuth start (GSC/GA4/GTM scopes)
GET    /v1/integrations/google/callback
POST   /v1/sites/:siteId/keyword-imports            multipart CSV/XLSX → 202
GET    /v1/sites/:siteId/keywords                   clustered, filterable
GET    /v1/sites/:siteId/keyword-clusters
GET    /v1/sites/:siteId/performance                page×query rollups, windows, trends
GET    /v1/pages/:pageId/performance
GET    /v1/sites/:siteId/gtm/audit
```

### Phase 3 — Opportunities & roadmap

```text
GET    /v1/sites/:siteId/opportunities              scored, explainable, filterable
GET    /v1/opportunities/:id                        full evidence + score components
POST   /v1/opportunities/:id/dismiss
GET    /v1/sites/:siteId/roadmap
POST   /v1/sites/:siteId/roadmap/regenerate         → 202
GET    /v1/sites/:siteId/next-best-action
```

### Phase 4+ — Actions & execution (contract defined now, implemented later)

```text
POST   /v1/opportunities/:id/actions      create draft action from opportunity
GET    /v1/sites/:siteId/actions          status board
GET    /v1/actions/:id                    incl. patch, snapshots, QA, timeline
POST   /v1/actions/:id/approve            RBAC: seo_manager+; RED requires agency_admin
POST   /v1/actions/:id/reject
POST   /v1/actions/:id/execute            (approved only) → 202
POST   /v1/actions/:id/rollback           manual rollback
GET    /v1/actions/:id/qa                 QA run detail
GET    /v1/sites/:siteId/snapshots
```

### Cost & observability (Phase 2+, admin)

```text
GET    /v1/organizations/current/ai-costs           today/month, per client/module/task
GET    /v1/organizations/current/budgets
PUT    /v1/organizations/current/budgets
```

### Data lifecycle (admin, audited — retention per DATA-MODEL.md §12 / PRD §192)

```text
GET    /v1/organizations/current/retention           effective retention config
PUT    /v1/organizations/current/retention           override retention periods (bounded)
POST   /v1/admin/deletion-requests                   legal/security deletion request:
                                                     {targetType, targetId, reason} → 202;
                                                     immediate purge incl. token
                                                     crypto-shred; fully audited.
                                                     agency_admin: own-org targets;
                                                     platform admin: any target
                                                     (platform-admin route group)
GET    /v1/admin/deletion-requests/:id               status/result
```

Site/client DELETE endpoints perform soft-delete with a 30-day grace period;
restore via `POST /v1/clients/:id/restore` (and sites equivalently) during grace.

---

## 3. Internal module contracts (TypeScript, in `packages/contracts`)

These interfaces are the seams that keep the core provider-agnostic (PRD §15, ADR-0011).
Signatures are illustrative; Zod schemas define the wire types.

```ts
// ---- Tenancy (threaded through EVERYTHING) ----
interface TenantContext {
  organizationId: string;
  clientId?: string;
  siteId?: string;
  actor: { kind: "user" | "system" | "worker"; id: string };
}

// ---- CMS (WordPress first) ----
interface CmsConnector {
  verify(): Promise<CmsHealth>;
  listContent(cursor?: string): Promise<Page<CmsContentItem>>;   // Phase 1 (read)
  getContent(id: CmsContentId): Promise<CmsContentDetail>;
  detectCapabilities(): Promise<CmsCapabilities>;                // builders, seo plugin
  // Phase 4+ (write) — not implemented before Phase 4:
  applyPatch(patch: CmsPatch, key: IdempotencyKey): Promise<CmsWriteResult>;
  snapshot(id: CmsContentId): Promise<CmsSnapshotPayload>;
  restore(snapshot: CmsSnapshotPayload, key: IdempotencyKey): Promise<CmsWriteResult>;
}

interface SeoMetadataProvider {          // Yoast / RankMath / native (PRD §19)
  read(id: CmsContentId): Promise<SeoMetadata>;
  buildPatch(id: CmsContentId, changes: SeoMetadataChanges): CmsPatch;
}

// ---- Google ----
interface SearchConsoleProvider {
  listSites(): Promise<GscSite[]>;
  queryAnalytics(req: GscQuery): Promise<GscRows>;   // capped, windowed
  submitSitemap(url: string): Promise<void>;         // Phase 8
  inspectUrl(url: string): Promise<UrlInspection>;   // Phase 8
}
interface AnalyticsProvider { runReport(req: Ga4Query): Promise<Ga4Rows>; }
interface TagManagerProvider { exportContainer(id: string): Promise<GtmContainer>; }

// ---- Data providers (all optional/pluggable) ----
interface SerpProvider { fetchSerp(q: SerpQuery): Promise<SerpSnapshot>; }
interface BacklinkProvider { fetchBacklinks(target: string): Promise<BacklinkPage>; }

// ---- AI ----
interface LLMProvider {
  complete(req: LlmRequest): Promise<LlmStructuredResponse>;  // JSON-schema constrained
}
interface EmbeddingProvider {
  embed(texts: string[]): Promise<{ vectors: number[][]; model: string; dim: number }>;
}
// LlmRequest ALWAYS carries: taskId, promptId+version, modelClass, maxInputTokens,
// maxOutputTokens, outputSchema, cacheKey, tenant. The llm package enforces budgets,
// caching and logging — engines never call providers directly (AI-COST-ARCHITECTURE.md).

// ---- Storage / queue ----
interface StorageProvider {
  put(key: string, body: Buffer | Readable, meta?: ObjectMeta): Promise<StorageRef>;
  get(ref: StorageRef): Promise<Readable>;
  delete(ref: StorageRef): Promise<void>;
  presignGet(ref: StorageRef, ttlSec: number): Promise<string>;
}
interface JobEnqueuer {
  enqueue<T extends JobName>(name: T, payload: JobPayload<T>,
    opts: { tenant: TenantContext; idempotencyKey: string; priority?: number }): Promise<JobRef>;
}
// JobPayload schemas may contain ONLY ids/references + minimal routing metadata —
// never secrets, tokens, full HTML, large content, or full LLM prompts (enforced by
// the contracts' Zod schemas). The enqueuer's `tenant` is used for routing/metrics;
// consuming workers derive their authoritative TenantContext from the persisted
// run/action row the payload references, and abort on mismatch (SECURITY.md §4).
```

**Contract rules**

1. Every job payload and every LLM output has a Zod schema in `packages/contracts`.
   Invalid LLM JSON → one structured repair retry → fail the task (never guess-parse).
2. Adapters throw typed errors (`ProviderAuthError`, `ProviderQuotaError`,
   `ProviderUnavailableError`); the quota manager (PRD §163) maps these to
   backoff/retry policy centrally.
3. Engines depend on interfaces from `contracts`, never on concrete providers;
   provider selection happens in `integrations` composition roots.
4. Contract tests (recorded fixtures) pin external API shapes (`TESTING.md`).

---

## 4. WordPress plugin API (OrganicOS Connector)

Namespaced REST under `/wp-json/organicos/v1/`, authenticated per `SECURITY.md §WP`
(application password + per-site HMAC signing of request body/timestamp).

```text
GET  /health            plugin version, wp version, active plugins (relevant set)
GET  /capabilities      builders, seo plugin, permalink structure, cache plugin
GET  /inventory         paged content inventory (ids, types, modified, hashes)
GET  /content/:id       full content + meta + builder payload (read-only, Phase 1)
--- Phase 4+ (write bridge; absent from plugin v1 builds) ---
POST /snapshot/:id      capture server-side snapshot, returns payload
POST /apply             apply structured patch (idempotency key required)
POST /restore           restore from snapshot payload
POST /cache/invalidate  targeted cache purge after write
```

Plugin v1 ships **read-only** — write endpoints are compiled in only from Phase 4
onward, so a compromised Phase-1 deployment has no write surface.
