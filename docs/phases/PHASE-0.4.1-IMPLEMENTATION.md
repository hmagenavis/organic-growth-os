# PHASE-0.4.1 — Authorization Core & Organization Context (implementation record)

Status: **COMPLETE** — 2026-08-31
Scope source: `docs/phases/PHASE-0.md` §0.3b/§0.4 (authorization half only)
Verified against PostgreSQL 16 via Testcontainers. See §13.

Phase 0.3 answered *who is this user*. Phase 0.4.1 answers *what organization may this
user act in, and as what* — and nothing else. The invariant it exists to establish:

> Authentication proves identity. Authorization proves organization access.
> `app.current_org_id` may be set only after authorization succeeds.

Sub-phase 0.4.2 (member mutations, clients/sites APIs) is deliberately not started.

---

## 1. What was implemented

| Area | Where |
|---|---|
| Role vocabulary | `packages/authorization/src/roles.ts` |
| Permission vocabulary | `packages/authorization/src/permissions.ts` |
| Versioned permission matrix, `can()` | `packages/authorization/src/registry.ts` |
| Client access mode semantics | `packages/authorization/src/client-access.ts` |
| Context types (identity / organization / client) | `packages/authorization/src/context.ts` |
| Membership bootstrap port | `packages/authorization/src/store.ts` |
| `authorizeOrganization` | `packages/authorization/src/authorize.ts` |
| Authorization failures | `packages/authorization/src/errors.ts` |
| PostgreSQL membership bootstrap | `packages/database/src/authorization/membership-store.ts` |
| `withAuthorizedOrganization` (the canonical flow) | `packages/database/src/authorization/with-authorized-organization.ts` |
| Migration | `packages/database/migrations/0004_authorization.sql` |
| HTTP routes (`/auth/organizations`, `/organizations/:id`) | `apps/api/src/authorization/routes.ts` |
| 401 / 403 / 404 policy | `apps/api/src/authorization/problems.ts` |
| Response contracts | `packages/contracts/src/authorization.ts` |

`packages/authorization` holds no SQL, no HTTP, no cryptography and no session
lifecycle. It does **not** import `@organic-os/auth`. `packages/database` holds no
permission policy. They meet at the `MembershipStore` interface (ADR-0011), exactly as
authentication and persistence meet at `AuthStore`.

---

## 2. The bootstrap problem, and the mechanism chosen

### The problem

Tenant context may be established only after membership is proven. Membership rows are
themselves tenant-scoped under `FORCE ROW LEVEL SECURITY` (migration 0002). So proving
membership cannot require the tenant context it exists to authorize — that would set
`app.current_org_id` to an organization the caller may have no relationship with, in
order to find out whether it does.

### The mechanism: a narrowly-scoped authenticated-user membership lookup policy

Option A from the brief. Migration 0004 adds a transaction-local setting and two
permissive `SELECT` policies for the runtime role:

```sql
CREATE OR REPLACE FUNCTION app.authz_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.authz_user_id', true), '')::uuid
$$;

CREATE POLICY memberships_authorization_bootstrap ON memberships
  FOR SELECT TO organic_os_runtime
  USING (app.current_org_id() IS NULL AND user_id = app.authz_user_id());

CREATE POLICY organizations_authorization_bootstrap ON organizations
  FOR SELECT TO organic_os_runtime
  USING (app.current_org_id() IS NULL AND EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.organization_id = organizations.id AND m.user_id = app.authz_user_id()));
```

### Why it is safe

1. **Only your own rows.** The predicate compares each row against the setting, not
   against the query's `WHERE` clause. Establishing the context for user A and then
   asking for user B's rows returns nothing — tested directly.
2. **Fails closed.** `app.authz_user_id()` is NULL when unset, so the predicate is NULL
   and matches nothing. A query issued without establishing the context reads zero rows
   — the same construction as `app.current_org_id()` (0001) and `app.auth_user_id()`
   (0003).
3. **Disjoint from the tenant path.** `app.current_org_id() IS NULL` makes the policy
   inert inside any tenant transaction, so a permissive policy that ORs with
   `memberships_tenant_isolation` still cannot widen a tenant query. This is a property
   of the predicate, not a convention about call sites — asserted by a test that sets
   *both* settings at once and still sees only the tenant's rows.
4. **Grants nothing else.** Under the bootstrap context the runtime role reads its own
   membership rows and the organizations they point at. `clients`, `sites`,
   `site_settings`, `audit_logs` and `users` all read zero rows — asserted.
5. **Separate from authentication.** `app.authz_user_id` is a different setting from
   0003's `app.auth_user_id`. Authenticating a user does not unlock membership
   resolution; resolving membership does not unlock the identity point lookup.
6. **No new privilege.** No `BYPASSRLS`, no superuser, no `SECURITY DEFINER` function
   (asserted: `pg_proc.prosecdef` is empty in schema `app`), no new object owner, no
   new write grant. `FORCE ROW LEVEL SECURITY` is intact on every tenant table.
7. **No generic query API.** The port has exactly two methods, both keyed on the
   authenticated user id. There is no method that accepts another user's id and none
   that accepts a membership id, so a forged membership id has nothing to attack.

The alternatives (a `SECURITY DEFINER` resolver, a denormalised non-tenant membership
table) are compared in ADR-0015.

### The organizations policy

The second policy exists so a user in more than one organization can be shown a choice
with names attached, in one join rather than N queries. It reveals strictly nothing
beyond the membership rows themselves: its `EXISTS` clause is satisfied only for
organizations the caller is a member of, and that subquery is subject to the membership
policy above.

---

## 3. Authorization context lifecycle

Three types, never merged:

```
AuthenticatedIdentityRef        { userId }                       — from a session
        │
        │  requested organization id  (routing input: path, header or form)
        ▼
AuthorizedOrganizationContext   { userId, organizationId, membershipId, role,
                                  clientAccessMode, registryVersion, authorizedAt }
        │
        │  a specific client, proven to belong to the organization and be in scope
        ▼
AuthorizedClientContext         { …the above, clientId }
```

- `AuthenticatedIdentityRef` has no field from which an organization could be read, so
  holding a session cannot imply tenant authority. It is structurally satisfied by
  `AuthenticatedIdentity.user` from `@organic-os/auth` without either package importing
  the other.
- Every field of `AuthorizedOrganizationContext` comes from the persisted membership
  row. The requested organization id is an *input to the lookup*, not a field of the
  result, and `role` / `clientAccessMode` are never read from a request (§15 of the
  brief). Contexts are frozen.
- No secret is in any context: no session token, no token hash, no CSRF token, no
  password hash, and not `is_platform_admin`.
- Contexts live for one request. Nothing persists them, and nothing caches them.

---

## 4. Role / permission registry

`PERMISSION_REGISTRY_VERSION = 1`. The matrix is code, not database rows: a matrix that
can be edited at runtime cannot be reviewed in a diff and turns every role row into an
escalation target. `PERMISSION_REGISTRY_VERSION` is stamped onto every context, so a log
line states which matrix produced a decision.

Permission vocabulary (15), covering only what the Phase-0 foundation can do:

`organization.read` · `client.read` `client.create` `client.update` ·
`site.read` `site.create` `site.update` ·
`member.read` `member.invite_or_create` `member.update_role` `member.update_scope`
`member.remove` ·
`session.read_own` `session.revoke_own` `session.revoke_member`

| Permission | agency_admin | seo_manager | content_editor | analyst | client_viewer |
|---|---|---|---|---|---|
| organization.read | ✓ | ✓ | ✓ | ✓ | ✓ |
| client.read | ✓ | ✓ | ✓ | ✓ | ✓ (scoped) |
| site.read | ✓ | ✓ | ✓ | ✓ | ✓ (scoped) |
| session.read_own / revoke_own | ✓ | ✓ | ✓ | ✓ | ✓ |
| client.create / client.update | ✓ | — | — | — | — |
| site.create / site.update | ✓ | — | — | — | — |
| member.* | ✓ | — | — | — | — |
| session.revoke_member | ✓ | — | — | — | — |

`can(role, permission)` is a set membership test built from that table, so anything not
listed — unknown role, unknown permission, non-string input — is `false`. There is no
branch that could return `true` by accident.

### Where SECURITY.md was silent, this denies

SECURITY.md §3 speaks in capabilities, most of which belong to later phases. Two rows
map cleanly onto Phase-0 permissions ("Manage org, members, budgets" → agency_admin
only; "View analytics/opportunities" → all roles, client_viewer client-restricted).
It says nothing about **who may create or edit clients and sites**, or **who may read
the member list**.

Per §9 of the brief those default to **DENY** for every role except `agency_admin`, and
the open policy question is recorded here rather than guessed:

> **Unresolved:** whether `seo_manager` should hold `client.create` / `client.update` /
> `site.create` / `site.update`, and whether non-admin roles should hold `member.read`.
> Widening later is a one-line registry change plus a test row. It is deliberately not
> decided by this sub-phase.

`seo_manager`, `content_editor` and `analyst` therefore hold the same Phase-0
permissions today. That is honest rather than accidental: the capabilities that
distinguish them (integrations, action approval, content drafts) do not exist yet and
will bring their own permissions in their own phases.

---

## 5. Client access-mode semantics

`memberships.client_access_mode`, `NOT NULL`, **no database default** (ADR-0016):

| Mode | Meaning |
|---|---|
| `all_clients` | every client of the organization, subject to the role |
| `scoped` | only the `membership_client_scopes` rows — **zero rows means zero clients** |

The Phase-0.2 convention ("no rows = all clients the role permits") is gone. It made an
empty collection mean ALL to code that knew the convention and NONE to code that read
the collection literally, and the difference between those two readings is a privilege
escalation.

- No default on the column, and `clientAccessMode` is a required field of both
  `provisionMembership` and `MembershipRepository.create`, so a membership cannot exist
  without a decision someone made deliberately.
- `client_viewer` is pinned to `scoped` by `CHECK (role <> 'client_viewer' OR
  client_access_mode = 'scoped')`, because SECURITY.md §3 makes client restriction
  mandatory for that role and a constraint is cheaper to trust than a code path.
- Authorizing a client requires **all three** of: the role permission, organization
  ownership of the client, and the client access check. `requireClient` is the only
  place they are composed, and the order is role → ownership → scope, so a caller that
  could never hold the permission learns nothing about which clients exist.

---

## 6. Tenant transaction flow

`createAuthorizationService({ db, store }).withAuthorizedOrganization(identity,
requestedOrganizationId, fn)` is the one canonical path:

```
1. authorizeOrganization(store, identity, requestedOrganizationId)
     malformed id  → refuse (no query issued)
     no membership → refuse
2. build AuthorizedOrganizationContext from the membership row
3. BEGIN
4. SELECT set_config('app.current_org_id', context.organizationId, true)
5. fn(session)  — repositories, can(), require(), requireClient()
6. COMMIT / ROLLBACK — the setting disappears either way
```

HTTP handlers do not reproduce these steps and cannot skip one: the only way to obtain
repositories is to be inside step 5, and step 4 reads the **context**, never the
request. When membership fails, no transaction is opened at all.

The session handed to `fn`:

| Member | Purpose |
|---|---|
| `context` | authorization-derived facts |
| `repositories` | the tenant-scoped data surface, bound to `context.organizationId` |
| `can(permission)` | non-throwing role check, for shaping a response |
| `require(permission)` | throws `permission_denied` |
| `requireClient(permission, clientId)` | role **and** ownership **and** scope |
| `listScopedClientIds()` | the raw scope list; loaded at most once per transaction |

`listScopedClientIds` memoises **within one transaction** only. That is not an
authorization cache: it cannot outlive the request, and the membership it derives from
was read moments earlier in the same request.

---

## 7. 401 / 403 / 404 and the non-enumeration decision

| Internal failure | Response | Reasoning |
|---|---|---|
| no authentic session | 401 | The caller already knows whether it sent a session. |
| `permission_denied` | 403 | Only reachable once membership is proven, and only reports the caller's own role. |
| `no_membership` | 404 | 403 would confirm the organization exists; ids must not be enumerable. |
| `malformed_organization_id` | 404 | Answered identically to a miss. |
| `resource_not_in_organization` | 404 | Another tenant's client is indistinguishable from one that does not exist. |
| `client_out_of_scope` | 404 | Otherwise a scoped membership could discover clients outside its scope by comparing 403 against 404. |

The rule: **403 only once the caller is a proven member, and only about the caller's own
role. Everything about a resource the caller cannot reach is a 404.**

The four 404 causes produce byte-identical problem+json bodies apart from the request
id — asserted by a test that collects them into a `Set` and expects one entry. The
internal category is logged; it never appears in a response.

**Accepted cost.** A genuine member who lacks access to one client sees "not found"
rather than "forbidden", which is slightly worse to debug. The alternative hands anyone
holding any membership a working oracle for other tenants' resource ids.

---

## 8. Platform administration stays separate

`users.is_platform_admin` is not read anywhere in `packages/authorization` or in the
authorized-tenant path. It is not a field of any authorization context, and it is not in
any response body.

- A platform admin with no membership is refused exactly like any other non-member —
  including in `GET /auth/organizations`, which returns an empty list.
- A platform admin who *is* an ordinary `client_viewer` gets `client_viewer`
  permissions and nothing more.

Both are integration-tested. Platform-admin routes remain unbuilt (out of scope by §18
of the brief), and when they arrive they will be a separate route group with their own
policy boundary, not an escape hatch inside organization routes.

---

## 9. Security events vs tenant audit — the boundary

Some security events happen before any organization exists: a failed login, an invalid
session, a rate-limit trip, and now *a refused authorization* (the caller may be a member
of nothing). `audit_logs` is tenant-scoped and append-only, and inventing an
`organization_id` to make such an event fit would corrupt the one table whose integrity
matters most.

**Decision for Phase 0** — the smallest legitimate distinction, no new table:

| Class | Where it goes | Why |
|---|---|---|
| **A. Platform / pre-organization security events** — failed login, invalid or expired session, CSRF rejection, rate limiting, **authorization refused** | Structured logs (pino, redacted): request id, method, url, outcome/failure category, user id when known, source key | There is no organization to attribute them to. They are operational security telemetry, not tenant history. |
| **B. Organization audit events** — actions taken *after* authorization succeeded, by a known membership, inside a known organization | `audit_logs`, tenant-scoped, append-only, written inside the authorized tenant transaction | An organization exists, is proven, and owns the record. |

No class-B rows are written yet, because Phase 0.4.1 adds no mutation: the only
authorized operation is a read. The mutation endpoints that will write them are 0.4.2,
and `withAuthorizedOrganization` already hands them `repositories.auditLogs` bound to the
proven organization.

Persistent storage for class A (a global `security_events` table) is **not** built here.
It is only justified once there is something that reads it — alerting, or an operator
console — and both are later phases. What is guaranteed today: no organization id is
ever invented, and no security event is silently dropped.

---

## 10. Never trusting client input

- The organization identifier in a path is routing input. It is verified against the
  caller's membership on every request, and the tenant setting is written from the
  verified context rather than from the request.
- No organization choice is stored in the session. There is nothing to revalidate
  because there is nothing remembered — the choice arrives with each request and is
  proven each time.
- `role` and `client_access_mode` are not request-shaped anywhere: `packages/contracts`
  defines them only in *response* bodies. A request that carries
  `role=agency_admin` changes nothing, because nothing reads it.
- A membership row whose role or access mode this build does not recognise is rejected
  (`InvalidMembershipRecordError`) rather than coerced, and dropped from the listing
  response with an error log.

---

## 11. Performance

- Membership lookup is a single-row index probe on `UNIQUE (organization_id, user_id)`
  from migration 0001. Listing uses `memberships_user_id_idx` plus one join, not a query
  per organization.
- Client scope is loaded at most once per authorized transaction, and only for `scoped`
  memberships that actually authorize a client.
- Cost of an authorized request: one bootstrap transaction (two statements) plus the
  tenant transaction. No new index was added, because the existing ones already serve
  every lookup this sub-phase introduces.
- No security data was denormalised, and no authorization cache exists (§17 of the
  brief). If per-request lookup ever shows up in p95, the fix is a short-TTL cache with
  explicit invalidation on membership change — not a longer-lived one.

---

## 12. Database changes

### Migration `0004_authorization.sql` (forward-only, 0001–0003 untouched)

1. `CREATE TYPE client_access_mode AS ENUM ('all_clients', 'scoped')`.
2. `memberships.client_access_mode`, backfilled, then `SET NOT NULL`, with no default.
3. `CHECK (role <> 'client_viewer' OR client_access_mode = 'scoped')`.
4. `app.authz_user_id()` + `GRANT EXECUTE` to the runtime role.
5. The two bootstrap policies (§2).

**The backfill and `FORCE ROW LEVEL SECURITY`.** `FORCE RLS` subjects even the owning
role to the policies, and the policies on `memberships` / `membership_client_scopes` are
granted `TO organic_os_runtime, organic_os_provisioner` only. A backfill issued by the
migrator would therefore match **zero rows** and silently leave every membership at
whatever the fallback branch produced. The migration lifts `FORCE` for the single
`UPDATE` and restores it immediately, inside the migration's own transaction, so no
other session ever observes those tables unforced. A test asserts `relforcerowsecurity`
is true afterwards.

**Backfill rule.** `scoped` for `client_viewer` unconditionally (a narrowing — the safe
direction, and what SECURITY.md §3 always intended); `scoped` where scope rows exist;
`all_clients` otherwise. That preserves exactly what every pre-existing row meant under
the old convention, apart from the deliberate `client_viewer` narrowing.

### What was not weakened

No `BYPASSRLS`. No superuser path. No `SECURITY DEFINER` function. No role became an
object owner. No new write grant (`organizations` still has exactly `SELECT, UPDATE` for
the runtime role). `FORCE ROW LEVEL SECURITY` unchanged on every tenant table. All
Phase-0.2 tenant-isolation tests and all Phase-0.3 authentication tests pass unmodified.

---

## 13. Verification

All gates pass. Summary:

- `format:check`, `lint`, `typecheck` — clean. No `any`, no `@ts-ignore`, no lint
  suppression added.
- Unit tests: **394** across the workspace, all green — **147** new in
  `packages/authorization` (three files) and **14** new in `apps/api`
  (`authorization/routes.test.ts`). The 125 `packages/auth` tests are unmodified.
- Integration against PostgreSQL 16 (Testcontainers, `pgvector/pgvector:pg16`):
  **115** in `packages/database` (60 from Phases 0.2/0.3, unmodified, plus 55 new) and
  **29** in `apps/api` (17 authentication, unmodified, plus 12 new).
- Empty-database migration and upgrade-from-0003 migration both tested.
- Production build and `pnpm audit --audit-level critical` clean.

### Test coverage by requirement

| Requirement (§20 of the brief) | Where |
|---|---|
| unauthenticated cannot resolve membership | `apps/api/.../routes.test.ts`, `authorization.int.test.ts` |
| authenticated user resolves own membership | `bootstrap.int.test.ts`, `authorization.int.test.ts` |
| cannot resolve another user's membership | `bootstrap.int.test.ts` |
| cannot authorize an organization without membership | `authorize.test.ts`, `authorization.int.test.ts` (both layers) |
| forged organization id fails | `authorize.test.ts`, `bootstrap.int.test.ts`, `authorization.int.test.ts` |
| forged membership id fails | `bootstrap.int.test.ts` (structural: no method accepts one) |
| context established only after verification | `authorization.int.test.ts` |
| no `app.current_org_id` before authorization | `bootstrap.int.test.ts`, `authorization.int.test.ts` |
| context cleared after commit and after rollback | `authorization.int.test.ts` |
| Phase-0.2 isolation suite still green | `tenant-isolation.int.test.ts` (unmodified, 22 tests) |
| every role × every permission | `registry.test.ts` (75 table-driven cells) |
| unspecified permission denied | `registry.test.ts` (deny-by-default block) |
| platform-admin flag does not bypass | `authorization.int.test.ts` ×3, API `authorization.int.test.ts` |
| `all_clients` behaves explicitly | `client-access.test.ts`, `authorization.int.test.ts` |
| scoped reaches listed, not unlisted | `client-access.test.ts`, `authorization.int.test.ts` |
| scoped + zero rows = zero clients | `client-access.test.ts`, `authorization.int.test.ts` |
| cross-org scope impossible | `authorization.int.test.ts` (composite FK rejects it) |
| id guessing does not bypass scope | `authorization.int.test.ts` |
| valid session alone does not authorize a tenant | API `authorization.int.test.ts` |
| membership removal fails the next request | `authorization.int.test.ts`, API `authorization.int.test.ts` |
| role/scope change observed next authorization | `authorize.test.ts`, `authorization.int.test.ts` |
| no stale indefinite cache | `authorize.test.ts` (store call counting) |
| role × permission × client access mode | `client-access.test.ts` (30 cells) |
| non-enumerating 404s are indistinguishable | API `routes.test.ts`, API `authorization.int.test.ts` |
| upgrade migration from the 0003 schema | `upgrade-0004.int.test.ts` |

---

## 14. Deviations from the planning documents

| Deviation | Rationale |
|---|---|
| `membership_client_scopes` no longer means "all clients" when empty | The convention was ambiguous by construction; ADR-0016. SECURITY.md §3 and DATA-MODEL.md §3 updated so the old reading is gone rather than annotated. |
| A new package, `@organic-os/authorization` | §6 of the brief. Keeping business permissions out of `@organic-os/auth` is the whole point of the sub-phase; a module inside `auth` would make the boundary a naming convention. |
| `withAuthorizedOrganization` lives in `@organic-os/database`, not in `authorization` | It has to own a transaction, and transactions are that package's job. The policy it enforces is imported from `authorization`, which stays SQL-free (ADR-0011). |
| `client_viewer` is pinned to `scoped` by a CHECK constraint | SECURITY.md §3 already required it; a constraint makes it unbypassable by any future code path. |
| Cross-tenant refusals answer 404, not 403 | Non-enumeration (§7). Documented rather than assumed. |
| `GET /organizations/:organizationId` exists | The smallest real vertical that exercises the whole pipeline over HTTP. Clients/sites/member APIs remain out of scope. |
| The migration temporarily lifts `FORCE ROW LEVEL SECURITY` to backfill | Otherwise the backfill silently updates zero rows (§12). Restored in the same transaction; asserted by a test. |
| `seo_manager`, `content_editor` and `analyst` currently hold identical permissions | Their distinguishing capabilities do not exist in Phase 0. Denying rather than inventing (§4). |

---

## 15. Security notes and residual risk

1. **The runtime role can now read its own membership rows without a tenant context.**
   That is a genuinely larger surface than Phase 0.3 had. Compensating controls: the
   predicate is keyed on a setting only one module writes; the policy is inert whenever
   a tenant context exists; it exposes memberships and organization names only; and the
   port offers no method that accepts another user's id.
2. **`GET /auth/organizations` reports the caller's role and client access mode.** This
   is the caller's own authorization state, which it can observe anyway by making
   requests. It is informational: the server re-derives both from the membership row on
   every subsequent request and never trusts them coming back in.
3. **404-for-forbidden is a debuggability cost** (§7). Accepted deliberately.
4. **No audit rows for authorization decisions yet** (§9). Refusals are structured-logged
   with a failure category, request id and user id. The persistence boundary is
   designed; nothing writes across it until there are mutations to record.
5. **Login rate limiting is still single-process** (Phase 0.3 §8, tracked for 0.5).
   Unchanged by this sub-phase.
6. **Membership changes do not yet revoke sessions.** By design here: 0.4.1 adds no
   mutation endpoints. Because authorization is re-proven per request with no cache, a
   revoked membership already stops authorizing immediately — the session simply
   remains a valid *identity*. 0.4.2 must additionally rotate or revoke sessions on
   security-sensitive membership changes; `SessionService.rotateSession`,
   `revokeById` and `revokeAllForUser` exist for exactly that.

Nothing committed is a secret. No new environment variable was introduced.

---

## 16. Intentionally deferred (0.4.2 and later)

- Member mutation API (invite/create, role change, scope change, removal) and the
  session revocation that must accompany it.
- Clients and sites CRUD APIs; `site.*` and `client.*` write permissions exist in the
  registry but nothing calls them yet.
- The unresolved permission questions in §4 (`seo_manager` write access, `member.read`
  for non-admins).
- Organization provisioning / first-admin workflow, invitations, public sign-up.
- Platform-admin route group.
- Persistent platform security-event storage (§9).
- Audit-log rows for authorization and administrative events.
- Next.js dashboard, organization switcher UI.
- Redis, BullMQ, and everything downstream of them.
