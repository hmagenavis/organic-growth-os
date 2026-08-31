-- 0004_authorization.sql
-- Phase 0.4.1 — what authorization needs from the database, and nothing more.
--
-- Runs as the MIGRATION role (organic_os_migrator). Forward-only: 0001–0003 are
-- applied and immutable, so every change here is additive.
--
-- Two things are added:
--
--   1. memberships.client_access_mode — an explicit statement of whether a
--      membership reaches every client of its organization or only the clients
--      listed in membership_client_scopes;
--   2. a membership bootstrap path for the runtime role, so an authenticated user
--      can be shown to belong to a requested organization *before* any tenant
--      context exists.
--
-- (2) is the bootstrap problem this sub-phase exists to solve. Tenant context may be
-- established only after membership is proven, but membership data is itself
-- tenant-scoped (0002), so proving it cannot require the context it is meant to
-- authorize. The resolution here is the same construction 0003 used for
-- authentication: a transaction-local setting plus a policy narrow enough that it
-- can only ever return rows the caller already owns.
--
--   * the predicate is user_id = app.authz_user_id(), so a caller can resolve its
--     own memberships and no one else's;
--   * app.authz_user_id() returns NULL when unset, so with no context established
--     the predicate is NULL and matches nothing — fail-closed, exactly like
--     app.current_org_id();
--   * the policy additionally requires app.current_org_id() IS NULL, so the
--     bootstrap path and the tenant path are mutually exclusive: inside a tenant
--     transaction this policy contributes nothing, and a tenant query can therefore
--     never widen into another organization's membership rows;
--   * the setting is distinct from 0003's app.auth_user_id. Authenticating a user
--     does not unlock membership resolution, and resolving membership does not
--     unlock the identity lookup. Authentication and authorization stay separate
--     contexts (docs/SECURITY.md §3–§4).
--
-- No role gained BYPASSRLS, no SECURITY DEFINER function was created, no role became
-- an object owner, and FORCE ROW LEVEL SECURITY is intact on every tenant table at
-- the end of this migration.

-- ---------------------------------------------------------------------------
-- client_access_mode — removing the empty-scope ambiguity
--
-- Until now "no rows in membership_client_scopes" meant "all clients the role
-- permits" (0001). That makes an empty collection mean ALL in one place and NONE in
-- any code that forgets the convention, which is precisely the shape of a
-- privilege-escalation bug. The mode is now stated on the membership itself and the
-- scope table is only ever consulted for memberships that declare scoped access.
--
--   all_clients  every client of the organization, subject to the role.
--   scoped       only the clients listed in membership_client_scopes.
--                Zero rows therefore means zero clients — never all of them.
--
-- The column has NO database default: a membership must state its mode, so the
-- absence of a decision can never be silently read as the permissive one.
-- ---------------------------------------------------------------------------

CREATE TYPE client_access_mode AS ENUM ('all_clients', 'scoped');

ALTER TABLE memberships ADD COLUMN client_access_mode client_access_mode;

-- Backfill.
--
-- FORCE ROW LEVEL SECURITY subjects even the owning role to the policies, and the
-- policies on these two tables are granted TO organic_os_runtime /
-- organic_os_provisioner only. A backfill issued by the migrator would therefore
-- match zero rows and silently leave every membership at whatever the fallback
-- branch produced. Force is lifted for the statement and restored immediately,
-- inside this migration's own transaction, so no other session ever observes these
-- tables unforced.
ALTER TABLE memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE membership_client_scopes NO FORCE ROW LEVEL SECURITY;

UPDATE memberships m
SET client_access_mode = (
  CASE
    -- client_viewer is client-restricted by definition (docs/SECURITY.md §3), so it
    -- is narrowed unconditionally. Narrowing is the safe direction for a backfill.
    WHEN m.role = 'client_viewer' THEN 'scoped'
    -- Preserve the meaning every existing row was written under: listed clients if
    -- any were listed, otherwise the whole organization.
    WHEN EXISTS (
      SELECT 1 FROM membership_client_scopes s WHERE s.membership_id = m.id
    ) THEN 'scoped'
    ELSE 'all_clients'
  END
)::client_access_mode;

ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE membership_client_scopes FORCE ROW LEVEL SECURITY;

ALTER TABLE memberships ALTER COLUMN client_access_mode SET NOT NULL;

-- client_viewer is read-only and client-restricted (docs/SECURITY.md §3). Enforced by
-- the database so no application path — present or future — can create an
-- organization-wide client_viewer.
ALTER TABLE memberships
  ADD CONSTRAINT memberships_client_viewer_is_scoped
  CHECK (role <> 'client_viewer' OR client_access_mode = 'scoped');

COMMENT ON COLUMN memberships.client_access_mode IS
  'all_clients = every client of the organization, subject to role. scoped = only the membership_client_scopes rows; zero rows means zero clients.';

-- Authorization reads a membership by (user, organization) on every request; the
-- UNIQUE (organization_id, user_id) constraint from 0001 already serves that lookup,
-- and memberships_user_id_idx serves the bootstrap lookup by user alone. No new
-- index is justified.

-- ---------------------------------------------------------------------------
-- Authorization bootstrap context
--
-- Same construction as app.current_org_id() and app.auth_user_id(): read a
-- transaction-local setting, return NULL when unset so every comparison yields NULL
-- and matches no rows.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.authz_user_id() RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('app.authz_user_id', true), '')::uuid
$$;

COMMENT ON FUNCTION app.authz_user_id() IS
  'Transaction-local user id resolving its OWN memberships before any tenant context exists. NULL when unset so the bootstrap policies fail closed.';

GRANT EXECUTE ON FUNCTION app.authz_user_id() TO organic_os_runtime;

-- ---------------------------------------------------------------------------
-- memberships — self lookup
--
-- An additional PERMISSIVE policy: it ORs with memberships_tenant_isolation from
-- 0002, which is unchanged. The app.current_org_id() IS NULL guard makes the two
-- disjoint, so this policy can never widen a tenant-scoped query.
-- ---------------------------------------------------------------------------

CREATE POLICY memberships_authorization_bootstrap ON memberships
  FOR SELECT TO organic_os_runtime
  USING (
    app.current_org_id() IS NULL
    AND user_id = app.authz_user_id()
  );

-- ---------------------------------------------------------------------------
-- organizations — the organizations the caller is a member of
--
-- Needed so a user belonging to more than one organization can be shown a choice
-- before making one. It reveals nothing beyond what the membership rows above
-- already reveal: the EXISTS clause is satisfied only for organizations the caller
-- holds a membership in, and the subquery is itself subject to the membership policy
-- above.
-- ---------------------------------------------------------------------------

CREATE POLICY organizations_authorization_bootstrap ON organizations
  FOR SELECT TO organic_os_runtime
  USING (
    app.current_org_id() IS NULL
    AND EXISTS (
      SELECT 1
      FROM memberships m
      WHERE m.organization_id = organizations.id
        AND m.user_id = app.authz_user_id()
    )
  );
