# PHASE-0.4.2B1 — Clients management API (implementation record)

Status: **PASS** — verified 2026-09-02
All gates pass. The PostgreSQL suites were executed in GitHub Actions
(run `33611941595`, commit `3c279f6`, branch `phase/0.4.2b1-clients-api`); they cannot
run on the development machine, where Docker Desktop starts its processes but its
engine never answers and the local PostgreSQL 17 has no pgvector. See §14.
Scope source: `docs/phases/PHASE-0.md` §0.4.2 (client resource half only)

Phase 0.4.1 answered *what organization may this user act in, and as what*.
Sub-phase 0.4.2A added the mutations that change that answer for somebody else. This
sub-phase adds the first tenant **business** resource, and with it the rule the rest
of the product will be built on:

> Authorization for a client is **role permission AND client access scope**.
> Never one. Never "empty means all". Never a filter applied after the rows arrive.

Sites, invitations, client deletion and the dashboard are deliberately not started.

---

## 1. What was implemented

| Area | Where |
|---|---|
| Client orchestration (authorize → scope → repository → audit, one transaction) | `packages/database/src/clients/client-service.ts` |
| Authorization-aware paged listing, row lock, keyset cursor | `packages/database/src/repositories/clients.ts` |
| HTTP routes | `apps/api/src/clients/routes.ts` |
| Request-shape problem responses | `apps/api/src/clients/problems.ts` |
| Request/response contracts | `packages/contracts/src/clients.ts` |
| Permission policy decision (documentation only) | `packages/authorization/src/registry.ts` |
| App wiring | `apps/api/src/app.ts`, `apps/api/src/index.ts` |

**No migration.** The `clients` table from migration 0001 already carries every field
the approved product model needs for this sub-phase (§9). Migrations 0001–0005 are
untouched.

The package boundary from 0.4.1 is unchanged: `@organic-os/authorization` holds no
SQL, no HTTP and no transaction; `@organic-os/database` holds no permission policy;
`apps/api` holds neither. Nothing in `apps/api/src/clients/` can reach a repository,
open a transaction, set `app.current_org_id`, or read the caller's role.

---

## 2. Approved Phase-0 client permission policy

Unchanged from what the registry already encoded, which is why
`PERMISSION_REGISTRY_VERSION` is **still 1**. Bumping it would claim a change that did
not happen.

| Permission | agency_admin | seo_manager | content_editor | analyst | client_viewer |
|---|---|---|---|---|---|
| `client.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `client.create` | ✓ | — | — | — | — |
| `client.update` | ✓ | — | — | — | — |
| `client.delete` | *does not exist* | | | | |

This closes the second of the two open questions from
`PHASE-0.4.1-IMPLEMENTATION.md` §4, conservatively: **seo_manager does not get client
writes.** The endpoints that consume these permissions now exist, so the decision is
testable rather than hypothetical. Widening it later is a one-line change with a
table-driven test behind it; shipping a write permission nobody asked for and finding
it in production is an incident. `site.create` / `site.update` stay agency_admin-only
for the same reason, until the sub-phase that builds the sites API.

Every row above is additionally subject to §3. `client.read` on its own opens nothing.

---

## 3. Client access: two checks, both mandatory

```
AUTHORIZED = can(role, permission)
         AND client belongs to the authorized organization
         AND clientAccessAllows(membership.client_access_mode, scopeRows, clientId)
```

| Mode | Reach |
|---|---|
| `all_clients` | Every client of the authorized organization. New clients included, by policy. |
| `scoped` | Exactly the clients listed in `membership_client_scopes` for **this** membership. |
| `scoped`, zero rows | Exactly zero clients. Never "all". |

Both halves are enforced by the same function for a single resource —
`session.requireClient(permission, clientId)` in
`with-authorized-organization.ts`, which was written in 0.4.1 and is unchanged — and
by the same rule one query lower for a listing (§4). `client_access_mode` and the
membership id both come from the proven membership row; neither is ever read from a
request body, a header or a query parameter.

A **scoped agency_admin** is the sharp case, and it is tested in both suites: the
role grants the verb, not the reach. `PATCH` of a client outside that admin's scope is
refused, and refused as a non-enumerating 404 (§8) even though the caller holds
`client.update`.

---

## 4. List filtering strategy

Filtering happens **in PostgreSQL**, never in JavaScript over rows that were fetched
first.

```
all_clients:  SELECT … FROM clients
              WHERE organization_id = app.current_org_id()   -- + RLS, independently
              ORDER BY created_at, id LIMIT n+1

scoped:       SELECT … FROM clients
              JOIN membership_client_scopes s
                ON s.client_id = clients.id
               AND s.membership_id = <context.membershipId>
               AND s.organization_id = <context.organizationId>
              WHERE organization_id = …
              ORDER BY created_at, id LIMIT n+1
```

`ClientListAccess` is a discriminated union with no default and no third shape, so a
listing cannot be reached by a code path that meant "everything": the caller must state
the mode, and the `scoped` branch always joins. A membership with zero scope rows gets
an empty result from the inner join itself — from the database, not from a predicate
someone could forget to write.

Indexes used: `clients_organization_id_idx` and
`membership_client_scopes_client_id_idx` (both from migration 0001), plus the primary
keys. There is one query per page and no per-row authorization lookup, so there is no
N+1. See §12 for the index this would want at a scale Phase 0 does not have.

Row Level Security is untouched and still enforces the organization predicate on
`clients` and on `membership_client_scopes` independently of every line above.

---

## 5. Endpoint contracts

All four routes are registered only when a `ClientService` is wired into `buildApp`;
a deployment that omits it serves no client route at all rather than an unguarded one.
CSRF is enforced for `POST` and `PATCH` by the authentication plugin from Phase 0.3.

### `GET /organizations/:organizationId/clients`

Query: `?limit=<1..100>` (default 50), `?cursor=<opaque>`. Unknown parameters are a
400.

```jsonc
// 200
{
  "clients": [
    {
      "id": "uuid",
      "name": "Acme",
      "status": "active",          // reported, not writable — see §7
      "industry": "retail",        // nullable
      "notes": null,               // nullable
      "createdAt": "2026-09-02T10:00:00.000Z",
      "updatedAt": "2026-09-02T10:00:00.000Z"
    }
  ],
  "page": { "limit": 50, "nextCursor": "…" }   // nextCursor null on the last page
}
```

### `GET /organizations/:organizationId/clients/:clientId`

`200` with `{ "client": … }`, or the non-enumerating 404 of §8.

### `POST /organizations/:organizationId/clients`

Body (strict): `{ name, industry?, notes? }`. `201` with `{ "client": … }`.

### `PATCH /organizations/:organizationId/clients/:clientId`

Body (strict, at least one key): `{ name?, industry?, notes? }`. `200` with
`{ "client": … }`.

### No `DELETE`

Deliberate. Removing a client cascades today into `sites`, `site_settings` and
`membership_client_scopes`, and will later cascade into crawl state, opportunities,
actions and audit-bearing SEO history. A lifecycle designed around the four tables that
exist now would be the wrong one, and an archive/restore/purge distinction has to be
decided before the first row is removed. Deferred to 0.4.2B2+ (§15).

---

## 6. Response contracts

Responses are built field by field from a `ClientView`, never by serializing a
database row. `organizationId` is deliberately **absent** from every client object: the
caller supplied it in the path, so echoing it back adds nothing, and a business object
that carries a tenant identifier invites code that reads it back as authorization.

Field bounds mirror the database where the database has one. `clients.name` is
`CHECK (length(btrim(name)) BETWEEN 1 AND 200)` in migration 0001, so `name` is trimmed
and bounded identically in Zod — a blank or oversized name is a 400, never a constraint
violation surfacing as a 500. `industry` (120) and `notes` (4000) carry no database
bound; those limits are an API decision that keeps a request body finite, not an
invented schema rule.

---

## 7. Mutation rules

**Create.** `agency_admin` only. `organization_id` is not a parameter of
`clients.create` at all: the repository takes it from the tenant context, which came
from the proven membership. A body carrying `organizationId` is rejected by
`strictObject` before authorization runs, and could not be honoured if it were not.

**Update.** `agency_admin` only, **and** the target must be reachable under the actor's
own client scope. Rejected by the contract: `id`, `organizationId`, `createdAt`,
`updatedAt`, `status`, and every unknown field. The patch is an explicit optional field
per column — never an object spread into an `UPDATE` — so adding a column to `clients`
cannot silently make it patchable. `null` clears `industry` or `notes`; an absent key
leaves the column alone; an empty patch (`{}`) is a 400 rather than a silent no-op.

**`status` is not writable in this sub-phase.** `archived` is the archive half of the
lifecycle deferred with deletion; a client is created `active` and stays `active` until
that lifecycle is designed. It is reported so a UI can render it.

**Row lock.** An update locks its client row with `SELECT … FOR UPDATE` before reading
the `before` state, so the audit `before` is the state the update is actually applied
to rather than a snapshot another transaction has already moved past.

**Idempotence.** A patch whose values equal the stored row performs no `UPDATE`, does
not move `updated_at`, and writes no audit row. Recording a mutation that did not
happen would make the trail less trustworthy, not more (the same rule 0.4.2A applies to
a no-op role change).

**New clients do not widen scoped memberships.** Creating a client inserts no
`membership_client_scopes` row for anybody — not for other memberships, and not for the
creating administrator if that administrator is itself `scoped`. `all_clients`
memberships reach the new client by policy; `scoped` memberships reach it only after an
administrator says so through the 0.4.2A member-scope API, which remains the single
authority for scope administration. Proven in both integration suites.

---

## 8. Error policy and non-enumeration

The 0.4.1 mapping is reused unchanged (`apps/api/src/authorization/problems.ts`).

| Situation | Response |
|---|---|
| No authentic session | `401` |
| Proven member, role lacks the permission | `403` `permission-denied` |
| Not a member of the named organization | `404` |
| Malformed organization id | `404` |
| Client belongs to another organization | `404` |
| Client does not exist | `404` |
| Malformed client id | `404` |
| Same-organization client outside the caller's scope | `404` |

The last four are **byte-identical** apart from `instance` (which echoes a URL the
caller already knows) and `requestId`. None of them carries a `code`, deliberately: a
machine-readable discriminator would rebuild exactly the oracle the shared 404 exists
to remove. An integration test issues all four against one caller and asserts a single
distinct body.

403 is reachable only about the caller's *own* role, and only inside an organization it
has proven membership in. `requireClient` checks the role permission **first**, before
any client row is read — so a `seo_manager` attempting `PATCH` gets the same 403 whether
the client exists, belongs elsewhere, or is outside its scope. Permission refusal
therefore leaks nothing about existence either.

**Refusals are logged, never audited.** A forbidden or failed mutation rolls its
transaction back, and the transaction that would carry an audit row is the transaction
being rolled back; a "denied" row written from a second transaction would be a claim
about a mutation that never happened. The HTTP layer emits a structured
`authorization refused` log line instead, carrying the internal failure, the permission
and the resource *kind* — never the resource id and never anything that reaches the
response body. This is the 0.4.1 §9 policy, restated here because §14 of the sub-phase
brief asks for it explicitly.

---

## 9. Database changes

**None.** The existing `clients` table was inspected before the contracts were
designed:

```sql
CREATE TABLE clients (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  industry text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);
```

Consequences that shaped the API rather than the schema:

* **No uniqueness rule was invented.** The only `UNIQUE` is `(id, organization_id)`,
  which exists to make the composite foreign keys on `sites` and
  `membership_client_scopes` structurally tenant-safe — it is not a business key. There
  is no unique `name` or `slug`, so two clients may share a name, no
  `SELECT … EXISTS → INSERT` check exists anywhere, and there is no conflict to
  translate into a 409. If the product later requires a unique client key, it arrives
  as a database constraint first and a `409` mapping second, in that order.
* **No new column.** `status`, `industry` and `notes` are the whole mutable surface,
  and no CRM, billing, SEO-configuration, integration or WordPress field was added.
* `docs/DATA-MODEL.md` §A already describes this table accurately, so it needed no
  update.

---

## 10. Pagination

Keyset (cursor) pagination on the total order `(created_at, id)` ascending.

* **Default limit 50, maximum 100.** Over-maximum is a `400`, never a silent clamp: a
  caller that asked for 1000 and received 100 cannot tell that from an organization
  that has exactly 100 clients. The repository additionally re-clamps to 100, so the
  bound does not depend on the HTTP contract having run.
* **Deterministic order.** `id` is unique, so `(created_at, id)` is a total order and
  two clients created in the same transaction (identical `now()`) still order stably.
* **Cursor.** `base64url("<created_at as PostgreSQL renders it>|<uuid>")`. Opaque so the
  ordering can change without breaking callers, but not secret — it holds the
  `created_at` and `id` of a row the caller was just handed. It is validated
  structurally and bound as a query parameter, and a cursor that does not decode to a
  position in this ordering is a `400` (raised *after* authorization has already
  succeeded, so it can never be used to probe).
* **Why the database's own timestamp text, not a `Date`.** `timestamptz` carries
  microseconds; a JavaScript `Date` carries milliseconds. A cursor built from a `Date`
  would round `12:00:00.000500` down to `12:00:00.000` and hand the same row back on the
  next page. Round-tripping PostgreSQL's rendering keeps `(created_at, id) > (…, …)`
  exact.
* **No total count, deliberately.** The only honest count is "rows this caller may
  reach", which is an extra query for a number nothing needs yet; the organization's
  total would tell a `scoped` membership exactly how many clients exist outside its
  scope. `page` carries `limit` and `nextCursor` and nothing else, and a test asserts
  those are its only keys.
* No generic pagination framework was built. This contract lives in
  `packages/contracts/src/clients.ts` and the keyset predicate in the clients
  repository.

---

## 11. Audit

Two actions, both written **inside the same authorized transaction as the mutation**,
through the append-only repository from 0.4.2A:

| Action | `targetType` | `before` | `after` |
|---|---|---|---|
| `client.created` | `client` | `null` | state |
| `client.updated` | `client` | state | state |

`state` is `{ name, status, industry, notesPresent }`. Organization, actor user id and
actor membership id come from the tenant context (not from arguments), `source` is
`api`, `result` is `ok`, and `ip` is the socket peer — `trustProxy: false`, so it
cannot be forged with a header.

**`notes` is recorded as a boolean, not as text.** It is the only free-form field on
`clients`, which makes it the field most likely to accumulate a customer contact's
name, address or phone number, and `audit_logs` is append-only *by privilege* — the
runtime role holds `SELECT` and `INSERT` only, so anything written there can never be
corrected or erased. Recording *that* the notes changed keeps the trail readable; the
current text is always one read away on the client itself. This follows the 0.4.2A
precedent that kept email and name out of the membership audit payload. A test asserts
the note text appears nowhere in the trail.

Nothing else on `clients` is sensitive: the table holds no credential, no token and no
integration setting. No password, session token, CSRF token, cookie header or database
credential is reachable from the client service or its repository at all.

`audit_logs` grants, policies and append-only privilege are unchanged.

---

## 12. Performance

* One query per list page; no per-row authorization lookup; no N+1.
* One `SELECT … FOR UPDATE` plus one `UPDATE` per patch.
* No authorization caching between requests, and none inside one beyond the existing
  per-transaction scope memo in `with-authorized-organization.ts`. No Redis.
* **Known, accepted:** `clients` has an index on `organization_id` but not on
  `(organization_id, created_at, id)`, so a page is an index scan plus a sort. At
  Phase-0 client counts that is not measurable. The composite index is the right change
  when it becomes one, and it is a new migration rather than an edit to 0001–0005.

---

## 13. Tests

### Unit

| Suite | Covers |
|---|---|
| `packages/contracts/src/contracts.test.ts` | Default/maximum/over-maximum limit, unknown query parameter, name trimming and bounds, rejection of `organizationId` / `id` / `status` / `createdAt` / unknown fields, empty patch, `null` clearing |
| `apps/api/src/clients/routes.test.ts` | 401 before the service is reached on all four routes; routes absent when unwired; contract-shaped 200/201; default and maximum limit forwarded; six invalid `limit` values; unknown query parameter; cursor forwarded and 400 on failure; `organizationId` never forwarded; every immutable/unknown patch field; the five authorization failures mapped to 403/404; foreign vs out-of-scope byte-identity; refusal logged but not returned |

### Integration — `packages/database/src/clients/client-service.int.test.ts` (real PostgreSQL)

Read matrix (all_clients admin, scoped admin, seo_manager, content_editor, analyst,
client_viewer, client_viewer with zero scope rows); out-of-scope and malformed/unknown
ids; cross-tenant in both directions; platform admin does not bypass; write matrix per
role; scoped agency_admin refused an unscoped client and allowed its scoped one; create
audits exactly once with the correct actor membership and no note text; new client does
not widen a scoped membership; update before/after correctness; no audit for a no-op
patch; no audit for any refused mutation; full keyset walk with no repeats or gaps;
scope preserved across pages; three malformed cursors; repository-level limit clamp.

### Integration — `apps/api/src/clients/clients.int.test.ts` (real PostgreSQL, over HTTP)

The same matrix as a browser sees it, plus: 401 unauthenticated; CSRF required for
writes; foreign / absent / malformed / out-of-scope answered with one distinct body;
forged organization ids; platform admin blocked in A and ordinary in B; body
`organizationId` rejected; create audited once end to end; new client invisible to the
scoped viewer; patch before/after with the note text absent from the trail; every
immutable and unknown patch field; no audit for refused mutations; full page walk;
default/maximum/over-maximum limit and a bad cursor; `page` has no total.

---

## 14. Verification

Run on the resulting commit:

| Gate | Where | Result |
|---|---|---|
| `pnpm format:check` | local + CI | pass |
| `pnpm lint` | local + CI | pass |
| `pnpm typecheck` | local + CI | pass |
| `pnpm test` (unit, all packages) | local + CI | pass — 541 tests, 27 files |
| `pnpm test:integration` — `@organic-os/database` | CI | pass — 219 tests, 11 files |
| `pnpm test:integration` — `@organic-os/api` | CI | pass — 71 tests, 4 files |
| `pnpm build` | local + CI | pass |
| `pnpm audit --audit-level critical` | local + CI | pass — no known vulnerabilities |
| GitHub Actions CI | run `33611941595` | **green** |

The unit total includes the 34 contract tests and the 47 client-route tests added
here; the integration totals include this sub-phase's two new suites, which run the
matrices of §13 against real PostgreSQL with `FORCE ROW LEVEL SECURITY` on.

An earlier run of this branch (`33611590906`) failed at the unit-test step on an
unrelated pre-existing flake in `packages/auth`; see §17.4.

Reconfirmed by the integration suites rather than by inspection: `FORCE ROW LEVEL
SECURITY` intact, runtime role `NOSUPERUSER` / `NOBYPASSRLS`, no tenant context
leakage, no cross-client scope leakage, client read = permission AND scope, client
writes = agency_admin AND scope, scoped-with-zero-rows sees zero clients, a new client
does not widen scoped memberships, `audit_logs` still append-only, and a platform
administrator gets no organization authority.

---

## 15. Cloud

No cloud architecture work. `apps/api` still has no staging runtime host, so these
routes are **not exposed publicly** and no temporary deployment was created to
demonstrate them — they are verified through integration tests and CI, which is the
clean-room authority. No database credential was added to Vercel, no Vercel production
deployment or domain was touched, no Supabase JS/Auth was added, and `service_role` is
not used anywhere.

---

## 16. Dependencies

None added, in any package.

---

## 17. Deviations from the brief

1. **`status` is not writable.** §8/§10 of the brief permit only schema-supported
   fields; §3 defers the deletion/archive lifecycle. Accepting `status: "archived"`
   would implement the archive half of a deferred lifecycle, so it is read-only here.
2. **`notes` is audited as a boolean, not as text** (§11). The brief asks for "safe
   before state"; this is the reading of "safe" that matches the 0.4.2A precedent.
3. **No 409 conflict mapping.** §12 asks for one *if* a unique field exists. None does
   (§9), and inventing one was explicitly out of scope.
4. **One unrelated fix was required to reach a green gate.**
   `packages/auth/src/csrf.test.ts` → "rejects a tampered signature" was flaky and
   failed the first CI run of this branch. It tampered with the **last** character of
   the signature; a 32-byte HMAC is 43 base64url characters whose final character
   carries two unused padding bits, so about one run in sixteen the "tampered" token
   decoded to identical bytes and was correctly accepted. The test now alters the first
   character, which has no such slack. **`verifyCsrfToken` itself is unchanged and was
   never wrong**: it compares decoded bytes, so a token differing only in padding bits
   is the same token, and forging one still requires the HMAC. Verified with 30
   consecutive local runs.
5. **`AdministrationRequest` is reused** as the audit-origin type rather than a new
   near-identical `ClientRequest`, to avoid churn in 0.4.2A code. Its name is
   administration-flavoured; renaming it to something neutral is a candidate for the
   next sub-phase.

---

## 18. Intentionally deferred

* Client deletion and the archive/restore lifecycle, including the cascade decision.
* `status` mutation.
* Sites CRUD, invitations, dashboard/organization UI.
* A composite `(organization_id, created_at, id)` index on `clients`.
* Any widening of `client.create` / `client.update` to seo_manager.
* Total-count metadata on list endpoints.

---

## 19. Recommended scope for Phase 0.4.2B2

Sites, and nothing else:

1. `GET/POST/PATCH /organizations/:organizationId/clients/:clientId/sites`, with no
   `DELETE` — the same conservative shape as this sub-phase.
2. Authorization = `site.*` permission AND the **parent client's** access scope. A site
   is reachable exactly when its client is; the scope check belongs on the client, and
   `session.requireClient` already returns the `AuthorizedClientContext` to hang it on.
3. Reuse this sub-phase's pagination contract for the site collection rather than
   generalising it prematurely.
4. `site.created` / `site.updated` audit rows, same transaction, same shape.
5. Site settings (`site_settings`) stay out: autopilot mode and risk overrides are
   execution-safety policy, not CRUD, and belong with the phase that builds the
   execution engine.
6. Decide — as a written decision, not in code — whether `seo_manager` should hold
   `site.create` / `site.update`, given that it manages integrations under
   `docs/SECURITY.md` §3.
7. Still no deletion, no invitations, no UI, no Redis, no external integrations.
