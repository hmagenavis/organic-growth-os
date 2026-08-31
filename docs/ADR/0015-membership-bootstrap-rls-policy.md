# ADR-0015: Membership bootstrap via a narrow self-lookup RLS policy

Status: Accepted (2026-08-31 — sub-phase 0.4.1)

## Context

ADR-0002 makes tenant data reachable only under a transaction-local
`app.current_org_id`, and every organization-scoped table is under `FORCE ROW LEVEL
SECURITY`. Sub-phase 0.3 established that a valid session grants no tenant authority.

Sub-phase 0.4.1 has to turn an authenticated user id plus a *requested* organization id
into a proven authorization — and the proof lives in `memberships`, which is itself
tenant-scoped. Setting `app.current_org_id` to the requested organization in order to
read the membership would be circular: it would establish the very authority the read
is supposed to authorize, for an organization the caller may have no relationship with.

Something has to break the circle without giving the runtime role a general way to read
rows it does not own.

## Decision

Add a **transaction-local setting plus two narrow permissive SELECT policies** for the
runtime role (migration 0004):

```sql
CREATE POLICY memberships_authorization_bootstrap ON memberships
  FOR SELECT TO organic_os_runtime
  USING (app.current_org_id() IS NULL AND user_id = app.authz_user_id());

CREATE POLICY organizations_authorization_bootstrap ON organizations
  FOR SELECT TO organic_os_runtime
  USING (app.current_org_id() IS NULL AND EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.organization_id = organizations.id AND m.user_id = app.authz_user_id()));
```

`app.authz_user_id()` reads `current_setting('app.authz_user_id', true)` and returns
NULL when unset — the same fail-closed construction as `app.current_org_id()` (0001)
and `app.auth_user_id()` (0003). The setting is written in exactly one module,
`packages/database/src/authorization/membership-store.ts`, and only ever with the id of
the already-authenticated caller.

## Alternatives considered

- **A `SECURITY DEFINER` resolver function.** Every tenant table is `FORCE RLS`, so a
  definer function owned by the migrator still sees nothing; making it work would
  require granting the owning role a `USING (true)` policy on `memberships` — a scoped
  bypass, plus `search_path` hardening, plus a new privilege boundary to review. More
  moving parts and a strictly larger blast radius than a policy whose own predicate is
  the constraint.
- **`BYPASSRLS` or a superuser path.** Refused outright: it removes the second isolation
  layer the whole architecture rests on.
- **Denormalising memberships into a non-tenant table.** Duplicates security data,
  invents a synchronisation problem, and the duplicate would need the same policy anyway.
- **Trusting an organization id stored in the session.** Would make authorization a
  property of a cookie rather than of a persisted row, and would survive membership
  revocation.

## Consequences

- The runtime role can read **its own** membership rows and the organizations those rows
  point at, with no tenant context. Nothing else: no clients, sites, settings, audit
  rows or other users' memberships (asserted in `bootstrap.int.test.ts`).
- The `app.current_org_id() IS NULL` guard makes the bootstrap path and the tenant path
  **disjoint**, so the new permissive policies can never widen a tenant-scoped query —
  a property, not a convention.
- `app.authz_user_id` is deliberately a different setting from 0003's `app.auth_user_id`:
  authenticating a user does not unlock membership resolution, and resolving membership
  does not unlock the identity lookup.
- Membership is re-proven on every request. No authorization cache exists, so a removed
  membership or a changed role takes effect on the next request (§17 of the sub-phase
  brief). If this ever shows up in p95, the fix is a short-TTL cache with explicit
  invalidation, not a longer-lived one.
- See `docs/phases/PHASE-0.4.1-IMPLEMENTATION.md`.
