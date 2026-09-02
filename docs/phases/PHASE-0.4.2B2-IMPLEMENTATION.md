# PHASE-0.4.2B2 — Sites management API + safe initial site settings (implementation record)

Status: **PASS** — verified 2026-09-02
All gates pass. The PostgreSQL suites were executed in GitHub Actions (run
`33633981812`, commit `c3e2508`, branch `phase/0.4.2b2-sites-api`); they cannot run on
the development machine, where Docker Desktop starts its processes but its engine never
answers and the local PostgreSQL 17 has no pgvector. See §14.
Scope source: sub-phase brief 0.4.2B2; `docs/phases/PHASE-0.4.2B1-IMPLEMENTATION.md` §19

Sub-phase 0.4.2B1 established the rule for a tenant business resource:

> Authorization for a client is **role permission AND client access scope**.

This sub-phase adds the first resource that does not own its own authorization, and
the rule that follows from it:

> A site is authorized through its **parent client**.
> `authorized = site permission AND parent-client access`.
> There is no site-level scope system, and there will not be one.

And it adds the first *safety* invariant the product will be built on:

> Every site created through the service begins with a real `site_settings` row, in
> `autopilot_mode = 'review'`, committed in the same transaction as the site itself.

Site deletion, the archive/restore lifecycle, editable site settings, autopilot
graduation, integrations, crawling, invitations and the dashboard are deliberately not
started.

---

## 1. What was implemented

| Area | Where |
|---|---|
| Site orchestration (authorize → parent client → repository → settings → audit, one transaction) | `packages/database/src/sites/site-service.ts` |
| Base URL / time zone / language normalization | `packages/database/src/sites/normalize.ts` |
| Paged listing, ownership predicates, row lock, conflict translation | `packages/database/src/repositories/sites.ts` |
| Explicit `review` on settings creation | `packages/database/src/repositories/site-settings.ts` |
| Shared keyset-cursor primitives | `packages/database/src/repositories/keyset.ts` |
| HTTP routes | `apps/api/src/sites/routes.ts` |
| Request-shape and conflict problem responses | `apps/api/src/sites/problems.ts` |
| Request/response contracts | `packages/contracts/src/sites.ts` |
| Permission policy decision (documentation only) | `packages/authorization/src/registry.ts` |
| App wiring | `apps/api/src/app.ts`, `apps/api/src/index.ts` |

**No migration.** The `sites` and `site_settings` tables from migration 0001 already
carry every field, constraint and default this sub-phase needs (§9). Migrations
0001–0005 are untouched.

The package boundary is unchanged: `@organic-os/authorization` holds no SQL, no HTTP
and no transaction; `@organic-os/database` holds no permission policy; `apps/api` holds
neither. Nothing in `apps/api/src/sites/` can reach a repository, open a transaction,
set `app.current_org_id`, or read the caller's role.

---

## 2. Approved Phase-0 site permission policy

Unchanged from what the registry already encoded, which is why
`PERMISSION_REGISTRY_VERSION` is **still 1**. Bumping it would claim a change that did
not happen.

| Permission | agency_admin | seo_manager | content_editor | analyst | client_viewer |
|---|---|---|---|---|---|
| `site.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `site.create` | ✓ | — | — | — | — |
| `site.update` | ✓ | — | — | — | — |
| `site.delete` | *does not exist* | | | | |

This closes the written decision 0.4.2B1 §19.6 asked for, and it closes it
**conservatively**. The argument for giving `seo_manager` site writes is that it will
manage a site's integrations under `docs/SECURITY.md` §3. The argument against, which
won: authority over a *connection* does not imply authority over the structural
resource the connection hangs off. Creating a site establishes a new tenant object with
its own settings row and its own execution policy, and re-pointing a site's `base_url`
re-points every future crawl, snapshot and published change at a different property.
Neither is integration management. When the integration sub-phase needs `seo_manager`
to act, the permission it needs is `integration.*`, not `site.update`.

Every row above is additionally subject to §3. `site.read` on its own opens nothing.

---

## 3. Parent-client authorization is the whole authorization

```
AUTHORIZED = can(role, <site permission>)
         AND parent client belongs to the authorized organization
         AND clientAccessAllows(membership.client_access_mode, scopeRows, clientId)
         AND (for one site) site.organization_id = authorized organization
         AND (for one site) site.client_id      = authorized parent client
```

The first three lines are `session.requireClient(<permission>, clientId)` — written in
0.4.1, used unchanged — which returns an `AuthorizedClientContext`. **Every repository
call in this sub-phase uses `context.clientId`, never the route parameter.** The last
two lines are predicates on the site query itself.

Consequences, all tested:

* A `scoped` agency_admin holds `site.create` and `site.update` and still cannot touch
  a site under a client outside its scope. The role grants the verb, not the reach.
* A `client_viewer` with `scoped` and zero scope rows reaches zero sites — never all.
* A **real site of the caller's own organization, paired with the wrong client id in
  the URL**, is refused identically to a site that does not exist. This is the case
  route nesting invites people to get wrong, and it is asserted in both integration
  suites.
* `is_platform_admin` bypasses none of it.

No new scope table, no site-level access mode, no second scope concept.

---

## 4. Endpoint contracts

All four routes are registered only when a `SiteService` is wired into `buildApp`; a
deployment that omits it serves no site route at all rather than an unguarded one.
CSRF is enforced for `POST` and `PATCH` by the authentication plugin from Phase 0.3.

### `GET /organizations/:organizationId/clients/:clientId/sites`

Query: `?limit=<1..100>` (default 50), `?cursor=<opaque>`. Unknown parameters are 400.

```jsonc
// 200
{
  "sites": [
    {
      "id": "uuid",
      "baseUrl": "https://example.test",
      "cmsType": "wordpress",       // fixed; the only value the schema allows
      "status": "active",           // reported, not writable — see §6
      "timezone": "UTC",
      "language": "en",
      "autopilotMode": "review",    // read-only; null only if no settings row exists
      "createdAt": "2026-09-02T10:00:00.000Z",
      "updatedAt": "2026-09-02T10:00:00.000Z"
    }
  ],
  "page": { "limit": 50, "nextCursor": "…" }   // nextCursor null on the last page
}
```

### `GET …/sites/:siteId`

`200` with `{ "site": … }`, or the non-enumerating 404 of §8.

### `POST …/sites`

Body (strict): `{ baseUrl, timezone?, language? }`. `201` with `{ "site": … }`, or
`409` on a base-URL conflict (§10).

### `PATCH …/sites/:siteId`

Body (strict, at least one key): `{ baseUrl?, timezone?, language? }`. `200` with
`{ "site": … }`, or `409`.

### No `DELETE`, no archive/restore, no site-settings route

Deliberate, and asserted by tests that call `DELETE`, `POST …/archive`,
`GET …/settings`, `PATCH …/settings` and `PATCH …/autopilot` and require 404 from all
of them. Deletion cascades exactly as client deletion does and is deferred with it.
Editable settings are execution-safety policy — autopilot graduation, risk overrides,
execution preferences — which is not CRUD and belongs to the phase that governs it.

**Deviation from `docs/API-CONTRACTS.md`.** That document sketches `/v1/clients/:id/sites`
and `/v1/sites/:siteId`. This sub-phase keeps the organization-rooted path 0.4.2B1
established, because the organization in the path is what the membership is proven
against; a `/v1/sites/:siteId` route would have to infer the tenant from the resource,
which is the inversion the whole authorization design exists to prevent. The `/v1`
prefix and any flattening are a routing decision for the phase that ships the public
API surface.

---

## 5. Response contract

Responses are built field by field from a `SiteView`, never by serializing a row.

* `organizationId` and `clientId` are **absent**: both are in the request path, and a
  business object carrying tenant identifiers invites code that reads them back as
  authorization.
* `autopilotMode` is the **only** settings state exposed, and it is read-only. A caller
  needs to know whether a site is still in review; graduation policy, risk overrides,
  model-router overrides, ingestion overrides, crawl schedule, retention overrides,
  `graduated_at` and `graduation_approved_by` are internal execution policy and appear
  in no response. A unit test enumerates those keys and asserts their absence.
* `crawlBudget` is not exposed either — it is crawl configuration for a later phase.
* `autopilotMode` is nullable. `null` means no settings row exists, which this service
  cannot produce; it is reported honestly rather than defaulted to `review`, because
  inventing an execution-safety value is a claim about policy the database does not
  support.

---

## 6. Mutation rules

**Create.** `agency_admin` only, **and** the parent client must be in reach.
`organization_id` is not a parameter of `sites.create` at all — the repository takes it
from the tenant context — and `client_id` comes from the `AuthorizedClientContext`. A
body carrying either is rejected by `strictObject` before authorization runs, and could
not be honoured if it were not.

**Update.** `agency_admin` only, **and** the target must be reachable under the actor's
own client scope. Rejected by the contract: `id`, `organizationId`, `clientId`,
`createdAt`, `updatedAt`, `status`, `cmsType`, `crawlBudget`, `autopilotMode`, any
`site_settings` field, and every unknown key. The patch is an explicit optional field
per column — never an object spread into an `UPDATE` — so adding a column to `sites`
cannot silently make it patchable.

**A site cannot change client.** There is no `clientId` in the patch contract, *and*
the parent client is part of the row predicate the `UPDATE` runs against, so a site
that moved between the authorization check and the write updates nothing rather than
the wrong row.

**`status` is not writable.** `paused` and `archived` are the lifecycle deferred with
deletion. A site is created `active` and stays `active`; the value is reported so a UI
can render it. Same decision, same reason, as `clients.status` in 0.4.2B1.

**Row lock.** An update locks its site row with `SELECT … FOR UPDATE` before reading the
`before` state. The lock statement carries no join: `FOR UPDATE` cannot be applied to
the nullable side of an outer join, and the settings row is not what the lock protects.

**Idempotence.** A patch whose *normalized* values equal the stored row performs no
`UPDATE`, does not move `updated_at`, and writes no audit row. Normalizing before
comparing is what makes this honest: `https://a.test/` and `https://a.test` are the
same value, and an audit row claiming a change between them would be false.

---

## 7. Safe initial `site_settings`

```
BEGIN                                    -- opened by withAuthorizedOrganization
  requireClient('site.create', clientId) -- permission + organization + client scope
  INSERT INTO sites (organization_id ← context, client_id ← authorized client, …)
  INSERT INTO site_settings (site_id, organization_id ← context, autopilot_mode='review')
  assert autopilot_mode = 'review'
  INSERT INTO audit_logs (site.created, …)
COMMIT
```

Four properties, and each is enforced by a different mechanism so no single mistake
removes the invariant:

1. **The caller cannot choose a mode.** `CreateSiteRequest` has no autopilot field, the
   request contract is a `strictObject` that rejects `autopilotMode`, `autopilot_mode`,
   `siteSettings` and every other unknown key, and
   `siteSettingsRepository.createForSite` takes no mode parameter. Three independent
   refusals, tested at all three layers.
2. **The mode is written explicitly**, not left to the column default, so the invariant
   is visible in the code that establishes it and does not depend on migration 0001
   keeping `DEFAULT 'review'`.
3. **The service asserts it** after the insert and aborts the transaction if it is
   anything else. Unreachable through this code path; the safe answer if it ever is
   reached is to not commit.
4. **The transaction is the one `withAuthorizedOrganization` opened**, so the site, its
   settings and its audit row commit together. Two integration tests substitute a
   failing settings repository and a failing audit repository from *outside* the
   service — test-only composition of production interfaces, not a seam in the service
   — and assert that no site row survives either failure.

### Ownership is structural, not conventional

`site_settings.site_id` is `UNIQUE` and carries
`FOREIGN KEY (site_id, organization_id) REFERENCES sites (id, organization_id)`, so
"exactly one settings row, owned by the same organization" is a database property. The
parent client is transitive: `sites` is pinned to its client by
`FOREIGN KEY (client_id, organization_id) REFERENCES clients (id, organization_id)`.
No migration was needed, and none was written. A test proves the uniqueness half by
attempting a second `createForSite` for one site and requiring it to fail.

**Documented limitation.** The invariant is a *service-level* guarantee. A future
caller that reaches `repositories.sites.create` directly — as the Phase-0.2 test seed
does — can still create a site and skip the settings row, and the database would allow
it. Closing that at the database level means a deferrable constraint or a trigger, both
of which change the approved data model; per the brief that is a STOP, not a quiet
migration. `SiteService` is the only way the API creates a site, and
`SiteWithSettings.autopilotMode` reports `null` rather than inventing `review` if a row
without settings is ever read.

---

## 8. Error policy and non-enumeration

The 0.4.1 mapping is reused unchanged (`apps/api/src/authorization/problems.ts`).

| Situation | Response |
|---|---|
| No authentic session | `401` |
| Proven member, role lacks the permission | `403` `permission-denied` |
| Not a member of the named organization | `404` |
| Malformed organization id | `404` |
| Parent client in another organization / absent / malformed | `404` |
| Parent client outside the caller's scope | `404` |
| Site does not exist | `404` |
| Site in another organization | `404` |
| **Site of this organization under a different client** | `404` |
| Malformed site id | `404` |
| Base URL already used in this organization | `409` |
| Body/query shape, or a value that cannot be normalized | `400` |

The 404s are **byte-identical** apart from `instance` and `requestId`, and none carries
a `code`: a machine-readable discriminator would rebuild exactly the oracle the shared
404 exists to remove. An integration test issues five of them against one caller and
asserts a single distinct body.

403 is reachable only about the caller's *own* role. `requireClient` checks the role
permission **first**, before any client or site row is read, so a `seo_manager`
attempting `PATCH` gets the same 403 whether the site exists, belongs elsewhere, or is
outside its scope — asserted by comparing the response for a real site against one for
an id that does not exist.

A malformed site id is shape-checked in the service before it reaches PostgreSQL, so it
is refused as unreachable rather than surfacing as a failed cast.

The 400 for an unnormalizable value and the 400 for a bad cursor are raised **after**
authorization has already succeeded, so neither can be used to probe. Neither echoes
the rejected value: the field and the reason are structured-logged instead.

**Refusals are logged, never audited.** A forbidden or failed mutation rolls its
transaction back, and the transaction that would carry an audit row is the transaction
being rolled back. This is the 0.4.1 §9 policy, unchanged.

### The one accepted disclosure

`UNIQUE (organization_id, base_url)` is organization-wide, not per-client, so a `409`
can be raised by a URL held under a client the caller cannot reach. It is deliberate
and bounded: the response names no client, no site and no id — only that the
organization already uses the URL — and only a caller who has already proven
`agency_admin` membership of that organization can reach the code path. Answering `201`
would violate the constraint; answering `404` would lie. Narrowing the constraint to
`(client_id, base_url)` would be a schema change to the approved model and is not this
sub-phase's call.

---

## 9. Database changes

**None.** Both tables were inspected before the contracts were designed:

```sql
CREATE TABLE sites (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  base_url text NOT NULL CHECK (base_url ~ '^https?://[^[:space:]]+$'),
  cms_type text NOT NULL DEFAULT 'wordpress' CHECK (cms_type IN ('wordpress')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  timezone text NOT NULL DEFAULT 'UTC',
  language text NOT NULL DEFAULT 'en',
  crawl_budget jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, base_url),
  FOREIGN KEY (client_id, organization_id) REFERENCES clients (id, organization_id) ON DELETE CASCADE
);

CREATE TABLE site_settings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id uuid NOT NULL UNIQUE,
  autopilot_mode autopilot_mode NOT NULL DEFAULT 'review',
  … graduation / risk / router / ingestion / crawl / retention jsonb …
  CHECK ((graduated_at IS NULL) = (graduation_approved_by IS NULL)),
  FOREIGN KEY (site_id, organization_id) REFERENCES sites (id, organization_id) ON DELETE CASCADE
);
```

What that shaped, rather than what it made us change:

* **No uniqueness was invented** (§10). The one that exists is used, and it is used as
  the concurrency authority rather than as a hint.
* **No new column.** `base_url`, `timezone` and `language` are the whole writable
  surface. No WordPress credential, Search Console property, Analytics id, tag-manager
  configuration, crawl setting, SEO target, API key or model setting was added, and
  none has a column to be added to.
* **The settings default was already right.** `DEFAULT 'review'` in migration 0001
  matches the invariant; the service writes it explicitly anyway (§7.2).
* Row Level Security, `FORCE ROW LEVEL SECURITY`, grants and the append-only privilege
  on `audit_logs` are untouched.

---

## 10. Base URL, time zone and language

Normalization lives in `@organic-os/database` (`src/sites/normalize.ts`), not in the
contracts package. It is a **domain** rule, not a transport rule: the stored value has
to be identical whether a site arrives over HTTP or from a future importer, and
`UNIQUE (organization_id, base_url)` only means "one site" if every writer agrees on
what one URL is. The contract validates shape (present, bounded, no whitespace); the
domain decides the value. The cost is that a bad value is a 400 raised inside the
authorized transaction rather than before it — which is strictly safer, because an
unauthorized caller now gets 401/403/404 instead of a validation answer.

**Base URL — accepted:** an absolute `http`/`https` URL with a host, optionally with a
path. **Refused:** any other scheme, embedded credentials, a query string, a fragment,
an empty host, anything the WHATWG parser cannot read, and anything over 2048
characters. **Normalized:** trimmed; scheme and host lowercased and an
internationalized host punycoded (by the parser, so it cannot drift); a default port
dropped and a non-default port kept; a root-label trailing dot removed; trailing
slashes removed from the path. Path case is preserved, because paths are case-sensitive.
The result is asserted against the same regular expression migration 0001 enforces, so
a value this function produces can never surface as a constraint violation.

Deliberately **not** done: no scheme upgrade, no `www` folding, no `index.html`
stripping, no redirect following, and **no DNS or network lookup of any kind**. Each is
a claim about a site that only the crawler may make.

**Time zone:** validated and canonicalized against the platform's own IANA database, so
`asia/jerusalem` becomes `Asia/Jerusalem` and `Mars/Olympus` is refused. A fixed UTC
offset (`+02:00`), which ES2024 accepts as a time zone, is **refused**: it carries no
daylight-saving rule, so every schedule and reported date for the site would silently
shift by an hour twice a year.

**Language:** canonicalized as BCP-47 (`en-us` → `en-US`), malformed tags refused.

54 unit tests cover these three functions, including idempotence and the property that
no accepted value can violate the database CHECK.

---

## 11. Pagination

The 0.4.2B1 contract, reused rather than generalized: keyset pagination on
`(created_at, id)` ascending, default limit 50, maximum 100, over-maximum is a `400`
rather than a silent clamp, opaque base64url cursor built from PostgreSQL's own
`timestamptz` text rendering (never a JavaScript `Date`, which would round microseconds
and repeat a row), no total count, and a repository-level re-clamp so the bound does not
depend on the HTTP contract having run.

The **only** thing extracted is `packages/database/src/repositories/keyset.ts`: the
cursor encoder, the decoder and their two regular expressions, which would otherwise
exist twice. It is not a pagination framework — no query builder, no generic `Page<T>`,
no configurable ordering, no shared error type. Each repository still writes its own
keyset predicate, states its own limits, and throws its own cursor error, so
`InvalidClientCursorError` and its HTTP mapping are unchanged and `decodeKeysetCursor`
takes the error factory as an argument. **0.4.2B1 behaviour is byte-for-byte the same**,
and its suites are the check on that.

Sites additionally join `site_settings` (which is `UNIQUE (site_id)`, so one-to-one) to
carry the autopilot mode, which keeps the mode one query per page rather than one per
row. There is no N+1 and no per-row authorization lookup: the parent client is
authorized once, before the page is read.

---

## 12. Audit

Two actions, both written **inside the same authorized transaction as the mutation**,
through the append-only repository from 0.4.2A:

| Action | `targetType` | `before` | `after` |
|---|---|---|---|
| `site.created` | `site` | `null` | state + `clientId` + `autopilotMode` + `autopilotModeSource` |
| `site.updated` | `site` | state | state |

`state` is `{ baseUrl, cmsType, status, timezone, language }`. Organization, actor user
id and actor membership id come from the tenant context (not from arguments), `source`
is `api`, `result` is `ok`, and `ip` is the socket peer — `trustProxy: false`, so it
cannot be forged with a header.

`baseUrl` is recorded **in full**, unlike `clients.notes` in 0.4.2B1. The reasoning is
the same and points the other way: `notes` is free-form text likely to accumulate
personal data, while a base URL is the site's identity, is visible to every member who
can see the client, and a change of base URL is the single most consequential edit this
API allows — a trail that recorded only "the URL changed" could not answer what it
changed from.

Creation records `autopilotMode: 'review'` together with
`autopilotModeSource: 'system_policy'`, so the trail states that the mode was
established by policy and not chosen by the caller — neither value could have come from
the request.

Nothing sensitive is reachable: `sites` holds no credential, no token and no integration
setting, and no password, session token, CSRF token, cookie header or database
credential is reachable from the site service or its repository at all. `audit_logs`
grants, policies and append-only privilege are unchanged.

---

## 13. Tests

### Unit (local, no database)

| Suite | Covers |
|---|---|
| `packages/database/src/sites/normalize.test.ts` (54) | Base URL acceptance, refusal reasons, punycode, default ports, trailing dots and slashes, path case, idempotence, the database CHECK property, no value echoed in a message; IANA time zones and the offset-zone refusal; BCP-47 canonicalization; all three length bounds |
| `packages/contracts/src/contracts.test.ts` (+34) | Default/maximum/over-maximum limit, unknown query parameter, base URL trimming and bounds, whitespace refusal, rejection of `organizationId` / `clientId` / `id` / `autopilotMode` / `autopilot_mode` / `siteSettings` / `status` / `cmsType` / `crawlBudget` / `createdAt` / unknown fields, empty patch, reported autopilot modes |
| `apps/api/src/sites/routes.test.ts` (63) | 401 before the service is reached on all four routes; routes absent when unwired; **404 for DELETE / archive / restore / settings / autopilot**; contract-shaped 200/201; both routing ids forwarded and neither taken from a body; default and maximum limit; six invalid limits; unknown query parameter; cursor forwarded and 400 on failure; every immutable/unknown patch field; the 409 mapping; the 400 that does not echo the value but does log the reason; no execution-policy key in a response; the five authorization failures mapped to 403/404; foreign vs out-of-scope byte-identity; refusal logged, not returned |

### Integration — `packages/database/src/sites/site-service.int.test.ts` (real PostgreSQL)

Read matrix (all_clients admin, scoped admin, seo_manager, content_editor, analyst,
client_viewer, client_viewer with zero scope rows); **a real site paired with the wrong
parent client**; foreign, malformed and unknown ids; cross-tenant in both directions;
platform admin does not bypass and is ordinary in its own organization; create/update
matrix per role; scoped agency_admin refused an unscoped client and allowed its scoped
one; organization and client taken from context; normalization applied on create and
update; **every fixture site has exactly one settings row in `review`**; a second
settings row for one site is impossible; **a failing settings insert rolls the site
back**; **a failing audit insert rolls the site and its settings back**; a duplicate
base URL leaves no site, settings or audit row; two spellings of one URL conflict;
before/after correctness; no audit for a no-op patch, a refused mutation, or a failed
one; the autopilot mode never changes; full keyset walk with no repeats or gaps; scope
preserved across pages; three malformed cursors; repository-level limit clamp.

### Integration — `apps/api/src/sites/sites.int.test.ts` (real PostgreSQL, over HTTP)

The same matrix as a browser sees it, plus: 401 unauthenticated; CSRF required for
writes; five unreachable-site cases answered with one distinct body; out-of-scope and
foreign identical; a role refusal identical for a real and an absent site; cross-tenant
list/get/post/patch all refused; **a valid organization-A site id paired with another
client id refused, and the site unchanged**; platform admin blocked in A and ordinary in
B; create returns `review` and writes one audit row recording system policy; bodies
attempting `autopilotMode` / `autopilot_mode` / `siteSettings` / `organizationId` /
`clientId` / `id` refused and nothing created; a base URL that cannot be normalized
refused without echoing it; duplicate URL answered 409 naming nothing; scoped admin may
create only under its scoped client; update audited once with before/after; twelve
immutable/unknown patch bodies refused; no audit for a no-op or a refused patch; the
autopilot mode untouched by an update; a full page walk that never leaks another
client's or another tenant's site; default/maximum/over-maximum limit and a bad cursor;
`page` has no total; **DELETE / archive / settings / autopilot all 404**; and the
0.4.2B1 client API still answering.

---

## 14. Verification

Run on the resulting commit:

| Gate | Where | Result |
|---|---|---|
| `pnpm format:check` | local + CI | pass |
| `pnpm lint` | local + CI | pass |
| `pnpm typecheck` | local + CI | pass |
| `pnpm test` (unit, all packages) | local + CI | pass — 709 tests, 29 files |
| `pnpm test:integration` — `@organic-os/database` | CI | pass — 266 tests, 12 files |
| `pnpm test:integration` — `@organic-os/api` | CI | pass — 113 tests, 5 files |
| `pnpm build` | local + CI | pass |
| `pnpm audit --audit-level critical` | local + CI | pass — no known vulnerabilities |
| GitHub Actions CI | run `33633981812` | **green**, first attempt |

The unit total was 541 at the end of 0.4.2B1 and is 709 here; the difference is this
sub-phase's 54 normalization tests, 34 contract tests and 63 route tests, plus the
existing suites unchanged. The database integration total went from 219 to 266 and the
API integration total from 71 to 113 — this sub-phase's two new suites — with every
0.4.2B1, 0.4.2A, 0.4.1, 0.3 and 0.2 suite passing unchanged alongside them.

The PostgreSQL suites cannot run on the development machine: Docker Desktop starts its
processes but its engine never answers (`npipe:////./pipe/dockerDesktopLinuxEngine`
does not exist), and the local PostgreSQL 17 has no pgvector. This is the same
limitation recorded in 0.4.2B1 §14; GitHub Actions is the authoritative integration
verifier.

Reconfirmed by the integration suites rather than by inspection: `FORCE ROW LEVEL
SECURITY` intact, runtime role `NOSUPERUSER` / `NOBYPASSRLS`, no tenant context leakage,
site read = permission AND parent-client access, site writes = agency_admin AND
parent-client access, scoped-with-zero-rows sees zero sites, no cross-client or
cross-tenant ownership confusion, a platform administrator gets no organization
authority, site creation cannot select an autopilot mode, every service-created site
starts in `review`, the create transaction is atomic across site + settings + audit,
and `audit_logs` is still append-only.

The Phase 0.2 tenant-isolation, Phase 0.3 authentication, Phase 0.4.1 authorization,
Phase 0.4.2A membership and Phase 0.4.2B1 client regressions all pass unchanged in the
same run — including the client suites that are the check on the keyset helper
extraction of §11.

---

## 15. Cloud

No cloud architecture work. Cloud 0.1 is unchanged. `apps/api` still has no staging
runtime host, so these routes are **not exposed publicly** and no temporary deployment
was created to demonstrate them. No database credential was added to Vercel, no Vercel
production deployment or domain was touched, no Supabase JS/Auth library was added, and
`service_role` is not used anywhere.

---

## 16. Dependencies

None added, in any package.

---

## 17. Deviations from the brief

1. **`status` is not writable**, exactly as in 0.4.2B1. Accepting `paused` or
   `archived` would implement half of the deferred lifecycle.
2. **Normalization lives in `@organic-os/database`, not in the contracts package**
   (§10). The brief asks for deterministic minimal normalization; putting it in the
   contract as well would create a second authority for the meaning of the uniqueness
   constraint. The consequence — a value-level 400 raised after authorization — is
   stated in §8.
3. **A fixed-offset time zone is refused**, which is slightly stricter than "reject
   clearly invalid". The reason is in §10; a fixed offset is accepted by the platform
   and is still wrong for scheduling.
4. **`autopilotMode` is exposed and nullable** (§5). The brief permits reporting it;
   nullable rather than defaulted is the honest encoding of "no settings row".
5. **`baseUrl` is audited in full**, where 0.4.2B1 reduced `notes` to a boolean. The
   reasoning is in §12 and is the same principle applied to a different kind of field.
6. **A small keyset helper was extracted** (§11), which the brief permits only if it
   removes real duplication without changing 0.4.2B1 behaviour. It removes the cursor
   codec and two regular expressions; behaviour is unchanged and the 0.4.2B1 suites
   are the check.
7. **`AdministrationRequest` is reused** as the audit-origin type, as in 0.4.2B1. Its
   name is still administration-flavoured; renaming it remains a candidate for a later
   sub-phase.

---

## 18. Intentionally deferred (technical debt, stated)

* Site deletion and the archive/restore lifecycle, including the cascade decision, and
  `status` mutation. Deferred with client deletion.
* **Editable site settings**: autopilot graduation, risk overrides, model-router
  overrides, ingestion, crawl schedule, retention. No `GET`/`PATCH` on settings exists,
  by design.
* The database-level guarantee that *no* path can create a site without settings
  (§7). Today it is a service-level invariant plus honest reporting; closing it needs a
  deferrable constraint or a trigger, which changes the approved data model.
* Widening `site.create` / `site.update` to `seo_manager` (§2).
* A composite `(organization_id, client_id, created_at, id)` index on `sites`. There is
  `(organization_id, client_id)`, so a page is an index scan plus a sort; at Phase-0
  site counts that is not measurable, and the composite index is a new migration when it
  becomes so.
* Total-count metadata on list endpoints.
* Narrowing `UNIQUE (organization_id, base_url)` to the client, if the product ever
  wants two clients of one agency to hold the same URL (§8).
* WordPress, Search Console, Analytics, tag manager, crawling, keywords, Redis, BullMQ,
  invitations, dashboard, billing and every LLM path. Untouched.

---

## 19. Recommended scope for the next sub-phase

**0.4.2C — invitations and the member lifecycle**, or **0.5 — the dashboard shell**.
Both are defensible; the tenant resource layer (organizations, memberships, member
scopes, clients, sites) is now complete for Phase 0, and nothing else can be built on
it without either a way to get people into an organization or a way to see it.

If invitations: an invitation is a token-bearing object with an expiry and a single
use, so it belongs with the authentication package's token discipline rather than with
the resource CRUD pattern this sub-phase and the last one established — treat it as a
security sub-phase, not a fifth resource.

Whatever comes next, three things stay out until an explicit safety sub-phase claims
them: **editable site settings, autopilot graduation, and any execution path that can
change a customer's site.**
