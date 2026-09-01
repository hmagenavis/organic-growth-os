# PHASE-0.4.2A — Membership administration, session invalidation, tenant audit & secure provisioning (implementation record)

Status: **PASS** — verified 2026-09-01
Scope source: `docs/phases/PHASE-0.md` §0.4.2 (member administration half only)
All gates pass. The PostgreSQL suites were executed in GitHub Actions
(run `33485884835`, commit `dca344c`) after Cloud Foundation 0.1 made CI reachable;
they could not run on the development machine because Docker Desktop cannot start
there. See §15.

Phase 0.4.1 answered *what organization may this user act in, and as what*, and
deliberately added no mutation. This sub-phase adds the four mutations that change
that answer for somebody else, and the machinery each of them requires to be safe:

> A membership change and the session invalidation it forces are **one commit**.
> An organization can never commit a state with zero agency admins.
> An administrator can never quietly widen their own authority.

Sub-phase 0.4.2B (clients/sites CRUD, invitations, dashboard) is deliberately not
started.

---

## 1. What was implemented

| Area | Where |
|---|---|
| Administration policy (pure decisions) | `packages/authorization/src/membership-administration.ts` |
| Administration orchestration (locks, writes, revocation, audit) | `packages/database/src/administration/membership-administration.ts` |
| Email → user id point lookup, outside any tenant transaction | `packages/database/src/administration/user-lookup.ts` |
| Transaction-bound session revocation | `packages/database/src/authorization/session-revocation.ts` |
| `revokeMemberSessions` on the authorized session | `packages/database/src/authorization/with-authorized-organization.ts` |
| Repository additions (locking, joins, scope replacement) | `packages/database/src/repositories/memberships.ts`, `membership-client-scopes.ts` |
| Actor membership on audit entries | `packages/database/src/repositories/audit-logs.ts`, `src/tenant/context.ts` |
| Atomic, idempotent first-organization provisioning | `packages/database/src/provisioning.ts` |
| Operator command + hidden password prompt | `packages/database/src/cli/provision-organization.ts`, `src/cli/secret-prompt.ts` |
| Migration | `packages/database/migrations/0005_membership_administration.sql` |
| HTTP routes | `apps/api/src/administration/routes.ts` |
| Administration problem responses | `apps/api/src/administration/problems.ts` |
| Request/response contracts | `packages/contracts/src/membership-administration.ts` |

The package boundary from 0.4.1 is unchanged: `@organic-os/authorization` holds no
SQL, no HTTP and no transaction; `@organic-os/database` holds no permission policy.
They meet at values (`ClientAccessState`, `MembershipAdministrationError`) exactly as
they already met at `MembershipStore`.

---

## 2. Approved Phase-0 role policy

Unchanged from what the registry already encoded. `agency_admin` holds every `member.*`
permission and `session.revoke_member`; every other role holds none of them.

| Permission | agency_admin | seo_manager | content_editor | analyst | client_viewer |
|---|---|---|---|---|---|
| `member.read` | ✓ | — | — | — | — |
| `member.invite_or_create` | ✓ | — | — | — | — |
| `member.update_role` | ✓ | — | — | — | — |
| `member.update_scope` | ✓ | — | — | — | — |
| `member.remove` | ✓ | — | — | — | — |
| `session.revoke_member` | ✓ | — | — | — | — |

**No registry change was needed and none was made.** `PERMISSION_REGISTRY_VERSION`
stays at `1`, because no role's permission set changed — bumping it would claim a
change that did not happen.

What *did* change is that one of the two open questions recorded in
PHASE-0.4.1-IMPLEMENTATION.md §4 is now closed: **`member.read` stays
`agency_admin`-only.** The member list is administrative data, not a directory. The
other question — whether `seo_manager` should hold `client.create` / `client.update` /
`site.create` / `site.update` — is untouched here and belongs to 0.4.2B, which is the
sub-phase that builds those endpoints. The comment in `registry.ts` records the
resolution.

---

## 3. Member administration workflow

Five organization-scoped routes, all `agency_admin`-only:

```
GET    /organizations/:organizationId/members
POST   /organizations/:organizationId/members
PATCH  /organizations/:organizationId/members/:membershipId/role
PUT    /organizations/:organizationId/members/:membershipId/scopes
DELETE /organizations/:organizationId/members/:membershipId
```

Every mutation follows the same seven steps, and no handler can skip one because the
handler does not perform them — `MemberAdministrationService` does, inside
`withAuthorizedOrganization`:

```
1. prove membership in the requested organization      — no tenant context yet
2. require() the specific administration permission    — before any row is read
3. lock the rows the invariants are about, in id order — SELECT … FOR UPDATE
4. apply the policy decisions to the locked state
5. write the membership change
6. revoke the affected member's sessions               ┐ same transaction
7. append the tenant audit record                      ┘ as steps 3–5
```

Step 2 comes before step 3 on purpose: a caller who could never hold the permission is
refused before any membership id is looked up, so a 403 never doubles as an existence
oracle.

No handler sets a tenant context, and none can: the only way to obtain repositories is
to be inside step 3–7.

### Member creation semantics

`POST /members` **attaches an existing platform account**. It never creates one.

- The address is resolved to a user id *after* `member.invite_or_create` has been
  proven, in its own transaction with no tenant context, through the point-lookup
  policy migration 0003 already added (`user-lookup.ts` explains why it must not run
  inside the tenant transaction).
- An address with no account is answered `422` with
  `code: "INVITATION_FLOW_NOT_IMPLEMENTED"`. Nothing is created.
- **No default password is ever generated, and no credential is ever emailed.** There
  is no email provider in the repository and no invitation token type. An account with
  a password nobody chose is worse than an honest "that workflow does not exist yet".

---

## 4. Self-mutation policy

An administrator may not aim *any* membership mutation at their own membership: not a
role change, not a scope change, not a removal.

The rule is deliberately blunt rather than direction-aware:

- raising your own role is a privilege escalation with no second party;
- widening your own client access is the same escalation at client level;
- lowering or removing your own `agency_admin` membership is how an organization loses
  its last administrator through a UI mis-click — and the last-admin check alone would
  not catch it while a second admin still exists;
- narrowing yourself is safe in isolation, but allowing it means the endpoint decides
  *direction* on every call, and a direction check is the kind of thing that is wrong
  once.

A deliberate "leave organization" workflow is a separate, later decision. It is not
implemented here.

---

## 5. The last-agency-admin invariant, and why it needs a lock

> An organization with active membership administration may never commit a state with
> zero `agency_admin` memberships.

`lockForAdministration(targetMembershipId)` issues:

```sql
SELECT * FROM memberships
WHERE organization_id = <authorized org>
  AND (role = 'agency_admin' OR id = <target>)
ORDER BY id
FOR UPDATE
```

Three things about that statement are load-bearing:

- **It locks every admin row, not just the target.** The invariant is a statement about
  all of them at once. Reading the admins without locking them is the classic
  check-then-act race: two administrators each see two admins and each demotes one.
- **`ORDER BY id`** means every caller takes the same locks in the same order, so
  concurrent administrators queue instead of deadlocking.
- Under READ COMMITTED, `FOR UPDATE` **re-evaluates the predicate against the committed
  row version** once the lock is granted, so the second transaction sees the first
  one's effect rather than its own stale snapshot. That is what makes the count
  correct rather than merely serialised.

The arithmetic itself is a pure function, `assertAgencyAdminRemains`, counted rather
than compared against 1 so it is correct whether or not the target is currently an
admin.

**A property worth stating plainly:** in *sequential* use `last_agency_admin` is
unreachable, because the caller always holds `member.update_role` and therefore always
*is* an agency admin who remains. The self-mutation rule closes one half of the door
and the permission check closes the other. The invariant becomes reachable the moment
two administrators act at once — which is precisely what
`membership-concurrency.int.test.ts` exercises, and why the check exists as more than
decoration.

---

## 6. Role changes

- The role must be one of the five organization roles. `super_admin` and
  `platform_admin` are not in the enum, so a request naming one fails contract
  validation with `400` before reaching any policy.
- The target membership must belong to the authorized organization; anything else
  reads as absent (`404`).
- Self-targeting is refused (§4).
- The last-admin invariant is enforced under lock (§5).
- **The one transition that invalidates existing scope semantics is normalised, in the
  narrowing direction.** Becoming a `client_viewer` while holding `all_clients` would
  violate the `memberships_client_viewer_is_scoped` CHECK. Rather than refusing the
  demotion, the membership is atomically set to `scoped` **with zero clients**, and the
  administrator then grants clients deliberately. Nothing is ever widened by a role
  change: `scoped` is never converted to `all_clients`.
- A role change to the role the member already holds is an idempotent no-op: no write,
  no revocation, no audit row. Recording a mutation that did not happen would make the
  trail less trustworthy, not more.

---

## 7. Scope changes

`PUT …/scopes` is a **replacement**, not a patch. The request states the complete
resulting client access; there is no shape that means "leave the rest alone".

| Request | Meaning |
|---|---|
| `{ "mode": "all_clients" }` | every client of the organization, subject to the role. Existing scope rows are **deleted**. |
| `{ "mode": "scoped", "clientIds": [...] }` | exactly those clients. |
| `{ "mode": "scoped", "clientIds": [] }` | exactly **zero** clients. Never "all". |

- `{ "mode": "all_clients", "clientIds": [...] }` is a `400`. The schema is strict, so
  an administrator who sent a client list is never left believing it was applied.
- Duplicate client ids are a `400`, not silently collapsed: a scope list is
  authorization data, and the stored result must match what was sent.
- **Every listed client is authorized through the acting administrator**, with
  `requireClient('client.read', …)` — role permission **and** organization ownership
  **and** the administrator's own client scope. An administrator who is themselves
  `scoped` cannot grant a member a client they cannot reach. A client of another tenant
  and a client outside the admin's scope produce the same non-enumerating `404`.
- `client_viewer` + `all_clients` is refused (`409 CLIENT_VIEWER_REQUIRES_SCOPED`); the
  CHECK constraint is the backstop underneath.
- The replacement is atomic: delete-all then insert, inside the caller's transaction.
  There is no window in which the membership holds a partially-applied scope.

**Why `all_clients` deletes the scope rows.** In that mode the rows are not
authorization, and leaving authorization-shaped data lying around is how the ambiguity
ADR-0016 removed comes back. After any replacement, the stored state reads the same way
to code that takes the collection literally.

---

## 8. Session invalidation matrix

| Change | Sessions of the affected user |
|---|---|
| membership removed | **revoked** |
| role changed | **revoked** |
| `all_clients` → `scoped` (any list, including empty) | **revoked** |
| `scoped` → `scoped`, any previously listed client gone | **revoked** |
| `scoped` → `scoped`, strictly more clients | not revoked |
| `scoped` → `all_clients` | not revoked |
| no change (same role / identical scope) | not revoked |
| membership created | not revoked |

`isClientAccessNarrowing` is a total function over the four mode pairs, and any change
it cannot classify as broadening is treated as narrowing.

**Why broadening does not revoke, stated as a decision rather than an omission.**
Authorization is re-proven from the persisted membership on every single request, with
no cache anywhere (0.4.1 §6, §11). When access widens, the new access is already in
effect on the member's next request; nothing that was permitted has stopped being
permitted; and ending their session would be a logout with no security purpose. When
access narrows, the same re-proving argument would technically suffice for
*authorization* — but a session established under wider authority is exactly the thing
an incident review asks about, so it is ended.

**Revocation, not rotation.** Rotation replaces the caller's own session and needs the
raw cookie token, which an administrator acting on another member does not have and
must never be given. `revokeAllForUser`-style server-side revocation is the correct
primitive for administrative action on someone else.

If a future permitted path ever lets an administrator change their own
security-sensitive membership, the same revocation would end their current session.
Today no such path exists (§4).

---

## 9. Atomicity

Membership mutation, session revocation and the audit record are **one transaction**
(ADR-0017). The full argument is in the ADR; the short version:

- `sessions` is deliberately outside Row Level Security (migration 0002) because a
  session is resolved from a token hash before any organization is known. The runtime
  role therefore holds a plain `UPDATE` grant on it with no policy to satisfy, which
  makes the statement legal inside the tenant transaction that already carries
  `app.current_org_id`.
- The capability is exposed as exactly one method,
  `AuthorizedOrganizationSession.revokeMemberSessions(membership)`, which takes a
  membership *record* (obtainable only from a tenant-scoped repository) and re-checks
  its `organizationId` against the authorized context. The raw transaction handle is
  never exposed.
- A refusal at any step rolls all of it back. This is also why **no "denied" audit row
  is written**: the transaction that would carry it is the transaction being rolled
  back, and writing one from a second transaction would be a claim about a mutation
  that never happened. Refusals are structured-logged with their failure category, per
  the class-A/class-B boundary from 0.4.1 §9.

No package boundary had to be crossed and no compensating hack was needed, so the
"STOP and inspect the architecture" branch of the brief was not reached.

---

## 10. Tenant audit architecture

Four actions, all written inside the authorized tenant transaction, through
`repositories.auditLogs` bound to the proven organization:

| Action | `before` | `after` |
|---|---|---|
| `membership.created` | `null` | resulting state |
| `membership.role_changed` | prior state | resulting state |
| `membership.scope_changed` | prior state | resulting state |
| `membership.removed` | prior state | `null` |

Each row carries `organization_id`, `actor_kind = 'user'`, `actor_id` (the acting user),
`actor_membership_id` (the membership they acted through), `target_type =
'membership'`, `target_id`, `source = 'api'`, `ip` (the socket peer — the app runs with
`trustProxy: false`, so it cannot be forged with a header), `result = 'ok'` and
`created_at`.

The `before`/`after` payload is deliberately minimal:

```json
{ "userId": "…", "role": "analyst", "clientAccessMode": "scoped", "scopedClientIds": ["…"] }
```

Ids and policy values only — **no email and no name**. An append-only trail that can
never be corrected should carry the least personal data that still makes it readable,
and the user id resolves to both through the member list. No password, password hash,
session token, token hash, CSRF token, cookie header or `is_platform_admin` value is
reachable from anything in scope, and a test asserts the serialised rows contain none
of those strings.

`actor_id` and `actor_membership_id` both come from the **tenant context**, never from
arguments, so an entry cannot be attributed to someone the caller was not acting as —
the same property `actor_id` already had in Phase 0.2.

### Audit integrity

Unchanged from Phase 0.2 and re-asserted here: the runtime role holds only `SELECT` and
`INSERT` on `audit_logs`. `UPDATE` and `DELETE` are rejected by privilege before any
policy is consulted, so history cannot be rewritten by any application code path,
including this one. Insert is possible only with `organization_id =
app.current_org_id()`.

---

## 11. Provisioning

`provisionFirstOrganization` + `pnpm provision:organization` (ADR-0018).

```
pnpm provision:organization --name "Acme Agency" --slug acme --email ada@acme.test
```

- **Authority.** Requires `DATABASE_PROVISIONER_URL` (`organic_os_provisioner`). The
  runtime role holds no `INSERT` grant on `organizations` or `users`, so passing a
  runtime handle fails at the database. The API process opens only the runtime pool, so
  no request handler can provision. There is no HTTP route, no public sign-up and no
  platform-admin endpoint behind this.
- **Atomic.** Organization + administrator account (when created) + first
  `agency_admin` membership commit together, including the
  `set_config('app.current_org_id', …, true)` the membership insert needs. Any failure
  rolls all of it back.
- **Initial settings.** The current data model needs no additional rows:
  `organizations.settings` defaults to `{}` and `site_settings` is per-site, created
  with the site it belongs to (0.4.2B). Nothing else is initialised, and nothing is
  invented.
- **First membership.** `agency_admin`, `client_access_mode = all_clients` — the first
  administrator of an organization with no clients must be able to reach the ones they
  are about to create, and `scoped` with zero rows would leave a tenant nobody can
  administer.
- **Credentials.** If the address has no account and the terminal is interactive, the
  command prompts for a name and a password twice **with the echo off**, checks the
  platform policy, hashes with Argon2id at the production baseline, and passes only the
  encoded hash to `packages/database`. A password is never a command-line argument
  (shell history, `ps`, process listings) and never an environment variable. With stdin
  redirected the command refuses rather than consuming what was piped in. `--existing-user`
  disables the interactive path entirely.
- **Output.** Organization id, user id, membership id, and whether anything was
  created. No secret of any kind.

### Idempotency

Keyed on the **slug**: `INSERT … ON CONFLICT (slug) DO NOTHING`. A retry after a
timeout finds the existing row and returns the same identifiers with `created: false`.
A slug belonging to an organization this command did not create — or created with a
different first administrator — is refused (`organization_slug_taken`) rather than
joined, because silently attaching an administrator to somebody else's tenant is the
one mistake a provisioning command must never make.

The display **name** is deliberately not the key: two agencies may legitimately both be
called "Acme", and a test asserts two organizations with the same name and different
slugs are both created.

### Platform administration

Still not built, and not needed: provisioning is operator-only, so the platform-admin
route group stays deferred (0.4.1 §8). `users.is_platform_admin` is read nowhere in the
authorization path, is never granted by provisioning, and never implies membership.

---

## 12. Non-enumeration

The Phase 0.4.1 policy is extended to the new routes unchanged:

| Situation | Response |
|---|---|
| no authentic session | 401 |
| proven member, role lacks the permission | 403 |
| organization the caller is not a member of | 404 |
| malformed organization id | 404 |
| membership id from another organization | 404 |
| malformed membership id | 404 |
| client id from another organization in a scope request | 404 |
| client outside the *acting administrator's* scope | 404 |

Every 404 is byte-identical apart from the request id and the instance URL, and
**carries no `code` field** — which is what keeps the causes indistinguishable. Tests
collect them into a `Set` and expect one entry.

The administration-specific refusals *are* specific, and that asymmetry is deliberate:
each of them is only reachable by a caller who has already proven an `agency_admin`
membership in the organization it is administering, and each states a fact that caller
can read straight off the member list it is entitled to read.

| Failure | Response | `code` |
|---|---|---|
| self-targeted mutation | 409 | `SELF_MUTATION_FORBIDDEN` |
| would remove the last agency admin | 409 | `LAST_AGENCY_ADMIN` |
| user already a member | 409 | `MEMBERSHIP_ALREADY_EXISTS` |
| `client_viewer` asked for `all_clients` | 409 | `CLIENT_VIEWER_REQUIRES_SCOPED` |
| no account for that address | 422 | `INVITATION_FLOW_NOT_IMPLEMENTED` |

`code` is a new optional RFC 9457 extension member on `ProblemDetails` — a stable
identifier a client can branch on without parsing prose.

---

## 13. Output contracts

`GET /members` returns a deliberately selected projection:

```
membershipId · userId · email · name · role · clientAccessMode ·
scopedClientIds · createdAt · updatedAt
```

- The user fields are selected column by column in SQL (`id`, `email`, `name`), never
  by spreading the row, so a future column cannot leak by accident.
- `password_hash`, session data and `is_platform_admin` appear in no projection.
  Platform administration is not organization data and an agency admin has no business
  learning it.
- `email` is included because member administration without an addressable identity is
  unusable, and an administrator who may add, re-role and remove a member can already
  see who they are.
- `scopedClientIds` is empty for an `all_clients` membership even if scope rows somehow
  existed, because in that mode they are not authorization.

The `users` read is legal because the query joins through `memberships`, which is
exactly the predicate of `users_read_same_organization` (migration 0002).

---

## 14. Database changes

### Migration `0005_membership_administration.sql` (forward-only; 0001–0004 untouched)

One change:

```sql
ALTER TABLE audit_logs ADD COLUMN actor_membership_id uuid;
```

Nullable (workers and system actors hold no membership) and with **no foreign key** —
for the same reason `organization_id` has none: audit records outlive the rows they
describe, and a cascade from `memberships` would delete the record of a removal along
with the membership it recorded.

Everything else this sub-phase needs already existed: the `memberships` and
`membership_client_scopes` write grants and policies (0002), the composite foreign keys
that make a cross-organization scope structurally impossible (0001), the `sessions`
`UPDATE` grant outside RLS (0002), and the append-only `audit_logs` privileges (0002).
`SELECT … FOR UPDATE` needs no schema support, and `memberships_organization_id_idx`
already serves it, so no index was added.

**No `FORCE ROW LEVEL SECURITY` was lifted.** 0004 had to, for a backfill the migrator
could not otherwise perform; this migration adds a nullable column with no backfill, so
there was nothing to relax. `upgrade-0005.int.test.ts` asserts `relforcerowsecurity` on
all ten tenant tables afterwards anyway — asserting it after *every* migration is what
stops the 0004 exception from becoming a habit.

### What was not weakened

No `BYPASSRLS`. No superuser path. No `SECURITY DEFINER` function. No role became an
object owner. No new table-level grant: `organizations` still has exactly
`SELECT, UPDATE` for the runtime role and `users` exactly `SELECT` (plus the
column-scoped `UPDATE (last_login_at)` from 0003). Asserted.

---

## 15. Verification

### Static gates — all pass

| Gate | Result |
|---|---|
| `pnpm format:check` | clean |
| `pnpm lint` | clean — no `any`, no `@ts-ignore`, no suppression added |
| `pnpm typecheck` | clean |
| `pnpm test` (unit, whole workspace) | **460 passing**, up from 394 — 176 in `@organic-os/authorization` (29 new), 94 in `@organic-os/api` (37 new), remaining 190 unchanged |
| `pnpm build` | clean |
| `pnpm audit --audit-level critical` | no known vulnerabilities |

### Integration gates — PASS

Executed on `ubuntu-latest` in GitHub Actions, against real PostgreSQL 16 started by
Testcontainers, from a database created and migrated inside the runner:

| Suite | Tests |
|---|---|
| `packages/database` integration (10 files) | **193 passing** |
| `apps/api` integration (3 files) | **42 passing** |

Of those, the suites this sub-phase added:

| File | Tests |
|---|---|
| `administration/membership-administration.int.test.ts` | 45 |
| `administration/membership-concurrency.int.test.ts` | 5 |
| `provisioning.int.test.ts` | 18 |
| `migrations/upgrade-0005.int.test.ts` | 10 |
| `apps/api` `administration/administration.int.test.ts` | 13 |

The pre-existing suites ran unmodified and green: tenant isolation (22), the
authentication store (26), authentication over HTTP (17), the authorization core (31),
membership bootstrap (10), authorization over HTTP (12), empty-database migration (18)
and the 0003→0004 upgrade (8).

### What the first CI run found

The first run (`33485213688`) failed 13 tests, and **every one was a defect in the test
harness rather than in the product** — which is the outcome that makes the run worth
having, because each failure was a security control doing its job against a fixture
that had not respected it:

- **6 in `membership-administration.int.test.ts`.** A `beforeEach` widened
  `client_access_mode` to `all_clients` while the membership still held
  `client_viewer`, and `memberships_client_viewer_is_scoped` rejected it (SQLSTATE
  23514). The CHECK constraint from migration 0004 refused a state the architecture
  says cannot exist. Fixtures now restore the role before the access mode.
- **2 in `provisioning.int.test.ts`.** Two assertions read `memberships` with a bare
  provisioner query and no `app.current_org_id`, so Row Level Security correctly
  returned nothing. One of them — "no organization without an agency admin" — could not
  be asked as a single cross-tenant statement at all, and now asks it per organization
  under each organization's own context.
- **5 in `membership-concurrency.int.test.ts`.** `agencyAdminCount()` and the fixture
  reset had the same missing tenant context, so the count was always zero and the reset
  silently did nothing.

No production code changed (`dca344c`).

### Test coverage by requirement (written, pending execution)

| Requirement | Where |
|---|---|
| agency_admin may attach a legitimate user | `membership-administration.int.test.ts` |
| non-admin denied on every endpoint | both integration suites + `routes.test.ts` |
| cross-organization target manipulation denied | both integration suites |
| invalid / platform roles denied | `routes.test.ts` (contract), `membership-administration.test.ts` |
| self-demotion, self-scope-change, self-removal blocked | all three suites |
| last-admin demotion/removal blocked | `membership-administration.test.ts` (values), `membership-concurrency.int.test.ts` (reachable case) |
| client_viewer invariant enforced | all three suites |
| cross-tenant membership id rejected | `membership-administration.int.test.ts`, `administration.int.test.ts` |
| `all_clients` explicit, `scoped` explicit, `scoped []` = zero | `membership-administration.int.test.ts` |
| foreign client ids rejected | `membership-administration.int.test.ts`, `administration.int.test.ts` |
| duplicate client ids handled | `routes.test.ts` (400 before the service) |
| narrowing revokes; broadening does not | `membership-administration.int.test.ts`, `administration.int.test.ts` |
| `all_clients` → `scoped` revokes | `membership-administration.int.test.ts` |
| removal revokes target sessions | both integration suites |
| all target sessions revoked, unrelated user untouched | both integration suites |
| mutation + revocation cannot partially commit | `membership-administration.int.test.ts` (injected post-work failure) |
| audit row per mutation, correct before/after/actor/org | `membership-administration.int.test.ts` |
| forbidden attempt creates no success record | `membership-administration.int.test.ts` |
| audit row cannot be updated or deleted by runtime | `membership-administration.int.test.ts`, `upgrade-0005.int.test.ts` |
| no secret in any audit field | `membership-administration.int.test.ts` |
| concurrent admin demotions preserve ≥ 1 admin | `membership-concurrency.int.test.ts` (four scenarios) |
| provisioning atomic; rollback on failure | `provisioning.int.test.ts` |
| first membership is agency_admin / all_clients | `provisioning.int.test.ts` |
| idempotent retry does not duplicate | `provisioning.int.test.ts` |
| runtime cannot provision | `provisioning.int.test.ts` |
| provisioner has no DDL / superuser / BYPASSRLS | `provisioning.int.test.ts` |
| organization immediately usable by normal authorization | `provisioning.int.test.ts` |
| non-enumerating 404s indistinguishable | `routes.test.ts`, `administration.int.test.ts` |
| upgrade migration from the 0004 schema | `upgrade-0005.int.test.ts` |

---

## 16. Dependencies

**None added.** No email provider, no invitation library, no queue, no Redis. The
password prompt uses `node:process` raw mode and the argument parser uses
`node:util.parseArgs`; both are standard library.

---

## 17. Security notes and residual risk

1. **An agency admin can learn whether an address has a platform account.** `POST
   /members` necessarily distinguishes "attached" from
   `INVITATION_FLOW_NOT_IMPLEMENTED`. This is inherent to attaching an existing user
   with no invitation flow, is reachable only by a proven `agency_admin` of the
   organization, and is accepted for Phase 0 per §3 of the sub-phase brief. The
   invitation flow in 0.4.2B removes it, because an invitation is issued the same way
   whether or not an account exists. It is also unrate-limited, since login rate
   limiting is the only limiter that exists today.
2. **The authorized tenant session can now write one table outside the tenant
   boundary** (`sessions`). Narrowed by construction: one method, taking a record only
   a tenant-scoped repository can produce, with an organization re-check inside
   (ADR-0017).
3. **`last_agency_admin` is unreachable sequentially** (§5). That is a property of the
   self-mutation rule, not a gap; it is reachable and tested under concurrency. If the
   self-mutation rule is ever relaxed, this check becomes the only thing holding the
   invariant, which is why it exists now.
4. **No audit rows for refusals** (§9). Refusals are structured-logged with a failure
   category, request id and user id. `audit_logs.result` still has `denied` and `error`
   in its vocabulary; nothing writes them yet.
5. **Login rate limiting is still single-process** (Phase 0.3 §8, tracked for 0.5).
   Unchanged by this sub-phase.
6. **The provisioning credential is an operator secret.** Anyone holding
   `DATABASE_PROVISIONER_URL` can create tenants and accounts. That is the intended
   trust boundary (ADR-0018); it is not reachable from the network.
7. **Verified in CI, not on the development machine.** Everything asserted about
   PostgreSQL behaviour here — locking, revocation atomicity, RLS interaction, migration
   safety — is proven by GitHub Actions against real PostgreSQL, not by a local run.
   Docker Desktop cannot start on the development machine (§15), so CI is the only place
   these suites execute. That is the intended arrangement rather than a workaround:
   CI builds its database from migration 0001 every time, which is a stronger guarantee
   than a developer's long-lived local database (docs/cloud/CLOUD-ARCHITECTURE.md §3).

Nothing committed is a secret. No new environment variable was introduced.

---

## 18. Deviations from the planning documents

| Deviation | Rationale |
|---|---|
| A new nullable `audit_logs.actor_membership_id` column | §10 of the brief asks the audit record to name the acting membership, and it is not derivable later: a membership can be removed and re-created for the same `(user, organization)` pair. Additive, no backfill, no FORCE RLS lift. |
| `ProblemDetails` gains an optional `code` extension member | The sub-phase returns supported-domain outcomes a UI must distinguish (`INVITATION_FLOW_NOT_IMPLEMENTED` vs `LAST_AGENCY_ADMIN`). Non-enumerating 404s deliberately carry no `code`. |
| `tenantActorSchema`'s user variant gains an optional `membershipId` | So the actor membership comes from the context like `actorId` does, rather than from a repository argument that could attribute an entry to the wrong membership. |
| Administration orchestration lives in `@organic-os/database` | It owns a transaction and a row lock. Same reasoning that placed `withAuthorizedOrganization` there in 0.4.1; the policy it enforces is imported from `@organic-os/authorization`, which stays SQL-free. |
| `PUT …/scopes` deletes scope rows when the mode becomes `all_clients` | Leaving authorization-shaped rows that are not authorization reintroduces the ambiguity ADR-0016 removed. |
| Duplicate client ids are a 400 rather than deduplicated | A scope list is authorization data; the stored result must match what was sent. |
| Self scope changes are blocked, though §6 of the brief only named role and removal | A self scope change from `scoped` to `all_clients` is the same privilege escalation as a self role change. Blocking all three keeps the rule direction-free. |
| Granting a client requires the *acting administrator* to be able to read it | Least privilege, and it composes the check that already exists (`requireClient`) rather than inventing a second one. |
| No "denied" audit rows | The transaction that would carry one is the transaction being rolled back (§9). |
| Provisioning idempotency keyed on the slug | It is `UNIQUE`, operator-chosen and stable; the display name may legitimately repeat (ADR-0018). |
| `PERMISSION_REGISTRY_VERSION` not bumped | No role's permissions changed. Bumping it would claim a change that did not happen. |

---

## 19. Intentionally deferred (0.4.2B and later)

- Clients and sites CRUD APIs. `client.*` and `site.*` write permissions exist in the
  registry and nothing calls them yet; the open question about `seo_manager` holding
  them belongs to the sub-phase that builds them.
- Invitations: token type, expiry, single use, email delivery, and the credential
  onboarding flow that removes the `INVITATION_FLOW_NOT_IMPLEMENTED` answer and the
  account-existence oracle in §17.1.
- A deliberate "leave organization" workflow (§4).
- Creating a second organization for an existing user, and any self-service tenant
  creation.
- Platform-admin route group; persistent platform security-event storage.
- Audit log **read** API and a UI for it. Rows are written and readable through
  `repositories.auditLogs`; no endpoint exposes them.
- Password reset, MFA, OAuth.
- Next.js dashboard, organization switcher, member administration UI.
- Redis, BullMQ, and everything downstream.

---

## 20. Recommended scope for Phase 0.4.2B

In dependency order, smallest coherent pieces first:

1. **Clients CRUD** behind `client.read` / `client.create` / `client.update`, through
   `withAuthorizedOrganization` and `requireClient`, with audit rows
   (`client.created` / `client.updated`) and the non-enumeration policy unchanged.
   Resolve the open `seo_manager` write-permission question here, with a registry
   version bump if the answer is yes.
2. **Sites CRUD** behind `site.*`, including `site_settings` creation with
   `autopilot_mode = 'review'` (ADR-0014), pinned to a client of the same organization
   by the existing composite foreign keys.
3. **Audit log read endpoint** for `agency_admin`, paginated, with the same output
   contract discipline as the member list. It is the first consumer of the rows this
   sub-phase writes.
4. **Invitations** — the token type, its storage, expiry and single-use semantics, and
   the credential onboarding flow. This is what turns `POST /members` into a complete
   workflow and removes the account-existence oracle.
5. **Next.js dashboard** for login → organization selection → members → clients →
   sites, with loading/error/empty states per PRD §190.

Not in 0.4.2B: platform-admin routes, email delivery beyond invitations, MFA, OAuth,
Redis/BullMQ.
