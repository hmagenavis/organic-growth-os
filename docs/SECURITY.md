# SECURITY.md
# Organic Growth OS — Security Architecture

Version: 1.0 (planning baseline)
Scope: platform (web/api/worker/db), integrations, WordPress plugin, AI pipeline.
Non-negotiables from PRD §141: encrypted tokens, no plaintext credentials, RBAC,
least privilege, audit log, rate limiting, CSRF protection, secure cookies, tenant
isolation, webhook verification, token rotation, encrypted backups, revocation,
session management.

---

## 1. Threat model (summary)

| Actor | Vector | Primary defenses |
|---|---|---|
| Cross-tenant attacker (valid user, other org) | IDOR, query leakage | scoped repositories + RLS, 404-not-403, isolation tests |
| Credential thief | stolen OAuth/app-password rows | envelope encryption, key separation, rotation, revocation |
| Compromised WordPress site | poisoned crawl/plugin responses | treat all site content as untrusted data; schema-validate plugin responses; no eval; SSRF guards |
| Prompt injection via crawled content | page text instructing the LLM | structured outputs w/ closed schemas; content is data, never instructions; no tool-use agents on untrusted text; write path gated by deterministic risk engine + QA, never by LLM output alone |
| Malicious insider / role abuse | over-broad permissions | RBAC matrix, least privilege, append-only audit log |
| Our own execution engine | destructive writes | EXECUTION-SAFETY.md pipeline; risk classes; approvals; rollback |
| Infrastructure attacker | secrets in env/logs/backups | secret manager adapter, log redaction, encrypted backups |

## 2. Authentication & sessions

- Email + password: **argon2id** (memory-hard params reviewed at Phase 0), constant-time
  compare, generic error messages, per-IP + per-account rate limits with backoff.
- Sessions: server-side rows (`sessions` table), opaque 256-bit token, stored hashed.
  Cookie: `__Host-ogos_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, no JS access.
  Idle timeout + absolute lifetime; session rotation on login and privilege change;
  logout revokes server-side.
- CSRF: double-submit token bound to session for all mutating requests (SameSite is
  defense-in-depth, not the only control).
- MFA (TOTP) and SSO/OAuth login: designed-for (columns reserved) but post-MVP.
- No JWTs for user sessions (revocability wins); short-lived signed tokens only for
  internal worker→API needs if they ever arise.

## 3. RBAC (PRD §142, amended: organization roles only)

Organization roles: `agency_admin`, `seo_manager`, `content_editor`, `analyst`,
`client_viewer`. Permission matrix (enforced in one authorization module, checked at
API boundary AND at the execution engine for write actions):

| Capability | agency_admin | seo_manager | content_editor | analyst | client_viewer |
|---|---|---|---|---|---|
| Manage org, members, budgets | ✓ | — | — | — | — |
| Manage integrations | ✓ | ✓ | — | — | — |
| Change autopilot/risk settings | ✓ | — | — | — | — |
| Approve GREEN/YELLOW actions | ✓ | ✓ | — | — | — |
| Approve RED actions | ✓ | — | — | — | — |
| Edit content drafts | ✓ | ✓ | ✓ | — | — |
| View analytics/opportunities | ✓ | ✓ | ✓ | ✓ | ✓ (scoped clients) |
| View AI costs | ✓ | — | — | — | — |

- Client-level restriction is normalized in `membership_client_scopes`
  (membership_id, client_id, unique pair, FK cascade): rows present = membership is
  limited to those clients; no rows = all clients the role permits. Applies to any
  role, mandatory for `client_viewer`.
- Deny by default; permissions are additive; the matrix lives in code as data (testable).

**Platform administration (separate from org RBAC):** `users.is_platform_admin`
(Phase-0 design). Not an organization role; grants access only to a dedicated
platform-admin route group (ops dashboards, queue dashboards, deletion-request
processing, anonymized cross-tenant aggregates). It cannot be granted via any API —
migration/seed or manual audited SQL only — every use is audit-logged, and it does
not bypass RLS on tenant-data paths (cross-tenant reads happen only through the
dedicated aggregate views/role). Hardening (dedicated table, mandatory MFA) is
required before adding additional platform operators.

## 4. Tenant isolation (PRD §140)

- **Application layer:** all tenant-scoped data access goes through repositories that
  require `TenantContext`; no exported raw query path for tenant tables. Lint rule +
  code review enforce that engines never import the low-level client.
- **Database layer:** RLS on every tenant-scoped table
  (`organization_id = current_setting('app.current_org_id', true)::uuid`).
  Tenant context is **transaction-local only**: `SET LOCAL app.current_org_id = ...`
  (or `set_config(..., true)`) inside a transaction. Session-level `SET` is
  forbidden — with connection pooling, session state can leak across checkouts, so
  a lint rule + code review ban any non-LOCAL variant, and an integration test
  asserts a checked-back-in connection carries no tenant context. API/worker connect
  as a non-bypass role; migrations run as a separate privileged role.
- **Object storage:** keys prefixed `org/{orgId}/site/{siteId}/...`; presigned URLs
  are short-lived and generated only after an RBAC check.
- **Queues:** job payloads carry **IDs/references and minimal routing metadata
  only** — never secrets, OAuth tokens, full HTML, large content payloads, or full
  LLM prompts. A worker derives its `TenantContext` from the **trusted persisted
  run/action/import row** referenced by the payload (fetched first, under that row's
  own tenancy), not from an `organization_id` field in the payload itself; a
  payload/row tenant mismatch aborts the job with an alert. RLS context is then
  established transaction-locally per job. Job IDs are unguessable; queue dashboards
  are platform-admin only.
- **Cross-client learning:** only via aggregate views with k-anonymity thresholds
  (no URLs, queries, content, or business data across tenants — PRD §128).
- **Tests:** leakage tests are CI-blocking from Phase 0 (`TESTING.md`).

## 5. Secrets & integration credentials

- **Platform secrets** (DB URL, master keys, provider API keys): injected via
  environment from a secret manager (adapter: env-file in dev, cloud secret manager in
  prod). Never committed; never logged; startup validation fails fast.
- **Tenant integration tokens** (Google OAuth refresh tokens, WP application
  passwords): envelope encryption — AES-256-GCM data key per token row, data keys
  wrapped by a master key (`key_version`ed) held in the secret manager/KMS adapter.
  Decryption happens only in the worker/api process at point of use; plaintext is
  never persisted, cached, or logged.
- **Rotation:** master key rotation re-wraps data keys (background job); Google tokens
  refresh via OAuth; WP application passwords rotated on schedule (plugin support later).
- **Revocation:** deleting an integration deletes token rows and (best effort) revokes
  upstream (Google token revoke endpoint; WP app-password delete).
- **Log redaction:** serializer-level redaction list (authorization headers, token
  fields, cookies); tested with unit tests that assert redaction.

## 6. WordPress connector security

- Transport: HTTPS only; certificate validation on; no plaintext HTTP fallback.
- AuthN to WP: application password (Basic over TLS) for standard REST; the OrganicOS
  plugin additionally verifies a per-site shared-secret **HMAC signature** over
  (method, path, body-hash, timestamp) with a ±5 min window to prevent replay and to
  ensure only our platform can call plugin endpoints.
- Plugin follows least privilege: read-only build in Phase 1 (write endpoints not
  compiled in); write build (Phase 4+) checks WP capabilities per operation and
  rate-limits itself.
- All plugin/REST responses are schema-validated; oversized or malformed responses are
  rejected (a compromised site must not be able to poison our pipeline or DoS parsers).
- **SSRF guards** in the crawler and all URL fetchers: deny private/reserved IP ranges,
  resolve-then-connect pinning, redirect depth caps, scheme allowlist (http/https),
  per-host connection caps.

## 7. AI-pipeline security

- Crawled/site content is **data**. Prompts structurally separate instructions from
  content; outputs must conform to closed JSON schemas; no LLM output is ever executed,
  eval'd, or turned into a production write without passing the deterministic risk
  engine, validation, and (per mode) human approval.
- LLM providers receive minimal context (capsules), never credentials, tokens, or
  other tenants' data. Provider selection/data-processing terms reviewed per adapter.
- **Tenant-safe LLM cache:** cache keys are namespaced (`org:`/`site:`/`global`);
  any task whose input contains tenant data uses a tenant namespace, so identical
  inputs from different tenants never share a cached response. `global` is allowed
  only for prompt-registry entries explicitly classified non-tenant/public
  (AI-COST-ARCHITECTURE.md §5.1). Tenant-namespaced entries are purged with the
  tenant.
- **LLM logging privacy:** `llm_calls` stores metadata and hashes only — never raw
  prompts/responses. Optional debug captures are explicitly enabled, encrypted in
  object storage, redacted where possible, short-retention, and purgeable
  (AI-COST-ARCHITECTURE.md §13, DATA-MODEL.md §12).
- Business facts guard (PRD §45): generation tasks can only cite facts present in the
  business knowledge base; unverifiable claims are emitted as `UNKNOWN` and blocked by
  the content quality gate.

## 8. Platform hardening

- Rate limiting: global, per-session, per-org, and per-route buckets (Redis);
  auth endpoints strictest.
- Security headers (web): CSP (no unsafe-inline scripts), HSTS, X-Content-Type-Options,
  Referrer-Policy, frame-ancestors 'none'.
- Input validation: every request body/query validated by Zod at the boundary;
  file uploads (keyword CSV/XLSX) size-capped, content-type checked, parsed in the
  worker sandbox, never executed.
- Dependency hygiene: lockfile, `pnpm audit` in CI, Renovate-style updates.
- Webhooks (future inbound): HMAC signature verification + replay windows (PRD §141).
- Backups: encrypted at rest, access-controlled, restore drills (see TESTING.md).
- Audit log: append-only (no UPDATE/DELETE grants), covers auth events, permission
  changes, integration changes, all actions/executions, budget changes (PRD §143).

## 9. Data retention & deletion (PRD §192)

- Retention enforcement is a scheduled worker per artifact class; periods are
  configurable (global/org/site) with sane bounds; every purge writes audit rows.
- **Tenant offboarding:** client/site deletion = 30-day soft-delete grace, then full
  purge — DB rows, object-storage prefixes (`org/{orgId}/site/{siteId}/…`), vectors,
  and integration tokens (crypto-shred: destroy wrapped data keys, revoke upstream).
- **Legal/security deletion:** admin-only, audited, immediate-purge path that bypasses
  grace periods for specific artifacts or whole tenants (court order, breach
  containment). Requires a reason, is rate-unlimited but alert-raising, and is
  irreversible by design.
- Backups honor deletion: purged tenants are excluded from new backups; backup
  retention windows bound how long purged data can persist in old encrypted backups,
  and the restore runbook includes a re-purge step.

## 10. Phase 0 security acceptance (gate)

1. Login/logout/session expiry work; cookies configured as specified.
2. RBAC matrix enforced and unit-tested; deny-by-default verified.
3. RLS active on all tenant tables; leakage tests pass in CI.
4. Token encryption round-trip works; plaintext absent from DB dumps and logs
   (asserted by test).
5. Rate limiting active on auth routes.
6. Audit log rows produced for all Phase-0 mutations.
