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

Implemented in sub-phase 0.3 — see `docs/phases/PHASE-0.3-IMPLEMENTATION.md` for the
built architecture; this section is the requirement.

- Email + password: **argon2id** (OWASP baseline m=19456 KiB, t=2, p=1, configurable),
  library-provided constant-time verification, generic error messages, per-source +
  per-account rate limits.
- Sessions: server-side rows (`sessions` table), opaque 256-bit token, stored as a
  SHA-256 hash. Cookie: `__Host-organic-os-session`, `HttpOnly`, `Secure`,
  `SameSite=Lax`, `Path=/`, no `Domain`, no JS access. Local HTTP development uses a
  separately named non-`__Host-` cookie; production fails closed if asked to serve
  insecure cookies. Idle timeout (2 h) + absolute lifetime (12 h), both configurable;
  session rotation on login and privilege change; logout revokes server-side.
- CSRF: **signed** double-submit token bound to the session (or to `anonymous` before
  login) for all mutating requests, login included. The signature is what defeats
  cookie injection from a sibling subdomain; SameSite is defense-in-depth, not the
  only control.
- **Authentication is not authorization.** A valid session establishes identity only.
  It never sets `app.current_org_id` and confers no access to any organization-scoped
  table; that requires the separate authorization step in §3/§4.
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

- **Client-level restriction is explicit** (ADR-0016, migration 0004).
  `memberships.client_access_mode` is `all_clients` or `scoped`, `NOT NULL`, with no
  database default:
  - `all_clients` — every client of the organization, subject to the role.
  - `scoped` — only the `membership_client_scopes` rows (membership_id, client_id,
    unique pair, FK cascade). **Zero rows means zero clients**, never "all".
  Applies to any role; `client_viewer` is constrained to `scoped` by a CHECK
  constraint. Authorizing a client resource requires the role permission **and** the
  client access check **and** proof that the client belongs to the authorized
  organization — never one of the three.
- Deny by default; permissions are additive; the matrix lives in code as data
  (`packages/authorization/src/registry.ts`), versioned and table-tested against every
  role × permission cell.
- **Authorization is a separate package from authentication.** `@organic-os/auth`
  answers "who is this"; `@organic-os/authorization` answers "what may they do". The
  latter consumes a user id and does not import the former.
- **Membership bootstrap** (ADR-0015). Verifying that a user belongs to a *requested*
  organization happens before any tenant context exists, through a narrow self-lookup
  policy keyed on the transaction-local `app.authz_user_id`. It returns only the
  caller's own memberships, is inert whenever `app.current_org_id` is set, and grants
  no tenant access. No BYPASSRLS, no SECURITY DEFINER, no privileged connection.
- **The organization id in a request is routing input, never authorization.** It is
  verified against a persisted membership on every request; nothing is cached, and no
  organization choice is stored in the session and trusted thereafter.
- **Failure responses.** 401 when there is no authentic session. 403 only once the
  caller is a proven member and only about the caller's own role. Everything about a
  resource the caller cannot reach — absent, another tenant's, or outside its client
  scope — is an identical 404, so an authorization boundary cannot be used to
  enumerate resources.

- **Member administration** (sub-phase 0.4.2A). `agency_admin` only; every other role
  holds no `member.*` permission. Four mutations exist — attach, role change, client
  scope replacement, removal — and each of them:
  - refuses any mutation aimed at the caller's own membership (no self-escalation, no
    self-demotion, no self-removal; a deliberate "leave organization" flow is later);
  - preserves the invariant that an organization never commits a state with zero
    `agency_admin` memberships, enforced under `SELECT … FOR UPDATE` over every admin
    row of the organization in `id` order, not by a check-then-act count;
  - never widens client access implicitly. A role change to `client_viewer` while the
    membership holds `all_clients` is normalised **to `scoped` with zero clients**, and
    granting a client requires the acting administrator to be able to read it.
  - attaches existing accounts only. An address with no account is answered
    `INVITATION_FLOW_NOT_IMPLEMENTED`; **no default password is ever generated and no
    credential is ever emailed.**
- **Client API** (sub-phase 0.4.2B1). Reading a client is `client.read` **and** the
  membership's client access; writing one is `agency_admin` **and** the same client
  access — a scoped agency admin cannot mutate a client outside its scope, because the
  role grants the verb and not the reach. Collection endpoints are bounded (default 50,
  maximum 100, keyset cursor, deterministic `(created_at, id)` order) and carry no
  total count, so no response can report rows the caller may not read. `scoped`
  filtering is a join in PostgreSQL, never a JavaScript filter over rows already
  fetched. Creating a client writes **no** `membership_client_scopes` row: `all_clients`
  memberships reach it by policy and `scoped` ones do not until an administrator says
  so through the member-scope API. `client.create` / `client.update` stay agency_admin
  only for Phase 0 — the open question from 0.4.1 §4, closed conservatively. There is
  deliberately no client deletion and no `status` mutation: the archive/delete lifecycle
  cascades into sites, settings, scopes and future SEO history, and is designed in a
  later sub-phase.
- **Tenant audit for client mutations.** `client.created` and `client.updated` are
  written inside the authorized tenant transaction, with actor ids from the *context*.
  `before`/`after` hold `name`, `status`, `industry` and a boolean for whether notes are
  present — never the note text, because it is the one free-form field on `clients` and
  the trail is append-only by privilege. A refused mutation writes no audit row at all;
  it is structured-logged instead.
- **Session invalidation on membership change** (ADR-0017). Removal, role change and
  any narrowing of client access revoke **every** server-side session of the affected
  user. Broadening does not, because authorization is re-proven per request and nothing
  permitted stops being permitted. The membership mutation, the revocation and the
  audit record commit in **one transaction**, so "membership changed but sessions
  stayed live" is not a reachable state. Administrative action on another member uses
  server-side revocation, never cookie rotation.
- **Tenant audit for administrative mutations.** `membership.created`,
  `membership.role_changed`, `membership.scope_changed` and `membership.removed` are
  written inside the authorized tenant transaction, carrying the actor's user id and
  membership id from the *context* rather than from arguments. `before`/`after` hold
  ids and policy values only — no email, no name, and no credential, token or
  platform flag. `audit_logs` remains append-only by privilege.
- **Organization provisioning is not an API** (ADR-0018). Creating an organization, a
  user or the first `agency_admin` membership requires the provisioning role, which the
  request-serving process never connects with. The whole surface is the operator
  command `pnpm provision:organization`: atomic, idempotent on the organization slug,
  and it prompts for any new administrator's password with the echo off rather than
  accepting it as an argument or an environment variable.

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
  (or `set_config(..., true)`) inside a transaction. Authentication uses its own,
  separate transaction-local settings (`app.auth_email`, `app.auth_user_id`) that back
  a point-lookup policy on `users`; no tenant policy consults them, so resolving an
  identity grants no tenant access (sub-phase 0.3, migration 0003). Session-level `SET` is
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
