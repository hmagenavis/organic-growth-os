-- 0002_rls_and_grants.sql
-- Row Level Security policies and least-privilege grants.
--
-- Roles (created by bootstrap; names are fixed so migrations can grant to them):
--   organic_os_migrator     owns every object, performs DDL. No data policies.
--   organic_os_runtime      the API/worker role. No DDL, no BYPASSRLS, no superuser.
--   organic_os_provisioner  creates organizations and users (tenant provisioning),
--                           which by definition happens without a tenant context.
--                           No DDL, no BYPASSRLS.
--
-- Isolation model (docs/ARCHITECTURE.md §6, ADR-0002):
--   Layer 1  tenant-scoped repositories — the only data path in application code.
--   Layer 2  these policies, keyed on app.current_org_id(), which is set
--            transaction-locally and is NULL unless explicitly established.
--
-- FORCE ROW LEVEL SECURITY is applied to every organization-scoped table so that
-- even the table owner is subject to the policies. The exceptions are documented
-- inline below.

-- ---------------------------------------------------------------------------
-- Schema-level privileges
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO organic_os_runtime, organic_os_provisioner;
GRANT USAGE ON SCHEMA app TO organic_os_runtime, organic_os_provisioner;

-- Neither role may create objects anywhere.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM organic_os_runtime, organic_os_provisioner;
REVOKE CREATE ON SCHEMA app FROM organic_os_runtime, organic_os_provisioner;

GRANT EXECUTE ON FUNCTION app.current_org_id() TO organic_os_runtime, organic_os_provisioner;

-- ---------------------------------------------------------------------------
-- organizations
--
-- The tenant root. Runtime may read and update only its own organization and can
-- never create or delete one: provisioning a tenant is a privileged operation
-- performed by organic_os_provisioner.
-- ---------------------------------------------------------------------------

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

CREATE POLICY organizations_provisioner_all ON organizations
  FOR ALL TO organic_os_provisioner
  USING (true) WITH CHECK (true);

CREATE POLICY organizations_read_own ON organizations
  FOR SELECT TO organic_os_runtime
  USING (id = app.current_org_id());

CREATE POLICY organizations_update_own ON organizations
  FOR UPDATE TO organic_os_runtime
  USING (id = app.current_org_id())
  WITH CHECK (id = app.current_org_id());

GRANT SELECT, UPDATE ON organizations TO organic_os_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON organizations TO organic_os_provisioner;

-- ---------------------------------------------------------------------------
-- users
--
-- Global identities. Runtime may read only users who hold a membership in the
-- current organization, and may never create or modify a user — in particular it
-- can never set is_platform_admin, which is not an organization-grantable role.
-- ---------------------------------------------------------------------------

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY users_provisioner_all ON users
  FOR ALL TO organic_os_provisioner
  USING (true) WITH CHECK (true);

CREATE POLICY users_read_same_organization ON users
  FOR SELECT TO organic_os_runtime
  USING (
    EXISTS (
      SELECT 1
      FROM memberships m
      WHERE m.user_id = users.id
        AND m.organization_id = app.current_org_id()
    )
  );

GRANT SELECT ON users TO organic_os_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO organic_os_provisioner;

-- ---------------------------------------------------------------------------
-- Organization-scoped tables
--
-- One permissive FOR ALL policy per table covering SELECT/INSERT/UPDATE/DELETE.
-- WITH CHECK repeats the predicate so a row can neither be created in, nor moved
-- to, another organization.
-- ---------------------------------------------------------------------------

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_tenant_isolation ON memberships
  FOR ALL TO organic_os_runtime, organic_os_provisioner
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO organic_os_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO organic_os_provisioner;

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;
CREATE POLICY clients_tenant_isolation ON clients
  FOR ALL TO organic_os_runtime
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON clients TO organic_os_runtime;

ALTER TABLE membership_client_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_client_scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_client_scopes_tenant_isolation ON membership_client_scopes
  FOR ALL TO organic_os_runtime
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON membership_client_scopes TO organic_os_runtime;

ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites FORCE ROW LEVEL SECURITY;
CREATE POLICY sites_tenant_isolation ON sites
  FOR ALL TO organic_os_runtime
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON sites TO organic_os_runtime;

ALTER TABLE site_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY site_settings_tenant_isolation ON site_settings
  FOR ALL TO organic_os_runtime
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON site_settings TO organic_os_runtime;

ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations FORCE ROW LEVEL SECURITY;
CREATE POLICY integrations_tenant_isolation ON integrations
  FOR ALL TO organic_os_runtime
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON integrations TO organic_os_runtime;

ALTER TABLE integration_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_tokens_tenant_isolation ON integration_tokens
  FOR ALL TO organic_os_runtime
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON integration_tokens TO organic_os_runtime;

-- ---------------------------------------------------------------------------
-- audit_logs — tenant-scoped AND append-only
--
-- Append-only is enforced by privilege, not convention: runtime is granted only
-- SELECT and INSERT, so UPDATE and DELETE are rejected before any policy is
-- consulted. No role used by the application can rewrite history.
-- ---------------------------------------------------------------------------

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  FOR SELECT TO organic_os_runtime
  USING (organization_id = app.current_org_id());
CREATE POLICY audit_logs_tenant_append ON audit_logs
  FOR INSERT TO organic_os_runtime
  WITH CHECK (organization_id = app.current_org_id());
GRANT SELECT, INSERT ON audit_logs TO organic_os_runtime;

-- ---------------------------------------------------------------------------
-- Tables intentionally without Row Level Security
--
-- sessions:      not tenant-scoped. A session is resolved from a token hash before
--                any organization is known, so a tenant predicate cannot be
--                evaluated. Access is constrained by the token hash itself, and
--                authorization happens after the user is resolved.
--
-- feature_flags: global platform configuration, not tenant data. Runtime reads it;
--                only migrations and platform administration write it.
--
-- Both are documented in docs/phases/PHASE-0.2-IMPLEMENTATION.md.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO organic_os_runtime;
GRANT SELECT ON feature_flags TO organic_os_runtime;
