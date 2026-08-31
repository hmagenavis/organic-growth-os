-- 0001_foundation.sql
-- Phase 0.2 — identity, tenancy, platform and integration-shell foundation.
--
-- Runs as the MIGRATION role (organic_os_migrator), which owns every object created
-- here. Database roles and extensions are created beforehand by bootstrap, which is
-- the only step requiring a superuser.
--
-- Row Level Security, policies and runtime grants are applied in 0002.

CREATE SCHEMA IF NOT EXISTS app;

COMMENT ON SCHEMA app IS
  'Helper functions supporting tenant isolation. Holds no tenant data.';

-- ---------------------------------------------------------------------------
-- Tenant context
-- ---------------------------------------------------------------------------

-- Reads the transaction-local tenant identifier established with
-- set_config('app.current_org_id', <uuid>, true).
--
-- Returns NULL when unset, so every policy comparing against it yields NULL and
-- therefore matches no rows: tenant-scoped access fails closed by construction.
CREATE OR REPLACE FUNCTION app.current_org_id() RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('app.current_org_id', true), '')::uuid
$$;

COMMENT ON FUNCTION app.current_org_id() IS
  'Transaction-local tenant id. NULL when unset so RLS policies fail closed.';

CREATE OR REPLACE FUNCTION app.set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Enumerations (closed sets that gate behaviour)
-- ---------------------------------------------------------------------------

-- Organization roles only. Platform administration is NOT an organization role;
-- it lives on users.is_platform_admin (docs/SECURITY.md §3).
CREATE TYPE membership_role AS ENUM (
  'agency_admin',
  'seo_manager',
  'content_editor',
  'analyst',
  'client_viewer'
);

CREATE TYPE autopilot_mode AS ENUM ('off', 'review', 'safe_autopilot', 'full_autopilot');

CREATE TYPE integration_status AS ENUM ('connected', 'error', 'revoked', 'expired');

CREATE TYPE integration_token_kind AS ENUM (
  'oauth_refresh',
  'oauth_access',
  'app_password',
  'api_key'
);

-- ---------------------------------------------------------------------------
-- organizations — tenant root
-- ---------------------------------------------------------------------------

CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  slug citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER organizations_set_updated_at
BEFORE UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ---------------------------------------------------------------------------
-- users — global identities; a user may belong to several organizations
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email citext NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 320),
  -- Populated by the authentication sub-phase (0.3). No credential is stored here yet.
  password_hash text,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  locale text NOT NULL DEFAULT 'en',
  -- Platform-level flag. Never grantable through organization administration; it is
  -- set by migration/seed or audited manual SQL only (docs/DATA-MODEL.md §3).
  is_platform_admin boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ---------------------------------------------------------------------------
-- memberships — user ↔ organization with an organization role
-- ---------------------------------------------------------------------------

CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role membership_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id),
  -- Target for composite foreign keys that pin child rows to the same organization.
  UNIQUE (id, organization_id)
);

CREATE INDEX memberships_organization_id_idx ON memberships (organization_id);
CREATE INDEX memberships_user_id_idx ON memberships (user_id);

CREATE TRIGGER memberships_set_updated_at
BEFORE UPDATE ON memberships
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ---------------------------------------------------------------------------
-- clients — an agency's customer
-- ---------------------------------------------------------------------------

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

CREATE INDEX clients_organization_id_idx ON clients (organization_id);

CREATE TRIGGER clients_set_updated_at
BEFORE UPDATE ON clients
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ---------------------------------------------------------------------------
-- membership_client_scopes — restricts a membership to specific clients
--
-- Rows present  = the membership may only reach the listed clients.
-- No rows       = all clients of the organization, subject to the role.
--
-- The composite foreign keys make a cross-organization scope structurally
-- impossible: membership and client must share this row's organization_id, so a
-- membership in organization A can never be scoped to a client of organization B.
-- ---------------------------------------------------------------------------

CREATE TABLE membership_client_scopes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL,
  client_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (membership_id, client_id),
  FOREIGN KEY (membership_id, organization_id)
    REFERENCES memberships (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (client_id, organization_id)
    REFERENCES clients (id, organization_id) ON DELETE CASCADE
);

CREATE INDEX membership_client_scopes_organization_id_idx
  ON membership_client_scopes (organization_id);
CREATE INDEX membership_client_scopes_client_id_idx
  ON membership_client_scopes (client_id);

-- ---------------------------------------------------------------------------
-- sites — a client's website
-- ---------------------------------------------------------------------------

CREATE TABLE sites (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  base_url text NOT NULL CHECK (base_url ~ '^https?://[^[:space:]]+$'),
  cms_type text NOT NULL DEFAULT 'wordpress' CHECK (cms_type IN ('wordpress')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  timezone text NOT NULL DEFAULT 'UTC',
  language text NOT NULL DEFAULT 'en',
  crawl_budget jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, base_url),
  -- Pins the site to a client of the same organization.
  FOREIGN KEY (client_id, organization_id)
    REFERENCES clients (id, organization_id) ON DELETE CASCADE
);

CREATE INDEX sites_organization_id_idx ON sites (organization_id);
CREATE INDEX sites_organization_id_client_id_idx ON sites (organization_id, client_id);

CREATE TRIGGER sites_set_updated_at
BEFORE UPDATE ON sites
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ---------------------------------------------------------------------------
-- site_settings — per-site policy configuration
--
-- JSONB columns default to '{}' meaning "inherit the platform/organization
-- default". Concrete values (graduation thresholds, retention windows, ingestion
-- caps) are supplied and validated by typed application schemas, never hardcoded
-- into the database (PRD §106 amended, §192, §193).
-- ---------------------------------------------------------------------------

CREATE TABLE site_settings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id uuid NOT NULL UNIQUE,
  -- New sites start in REVIEW; SAFE_AUTOPILOT is an explicit, audited opt-in.
  autopilot_mode autopilot_mode NOT NULL DEFAULT 'review',
  graduation_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  graduated_at timestamptz,
  graduation_approved_by uuid REFERENCES users (id) ON DELETE SET NULL,
  risk_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_router_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingestion_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  crawl_schedule jsonb NOT NULL DEFAULT '{}'::jsonb,
  retention_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((graduated_at IS NULL) = (graduation_approved_by IS NULL)),
  FOREIGN KEY (site_id, organization_id)
    REFERENCES sites (id, organization_id) ON DELETE CASCADE
);

CREATE INDEX site_settings_organization_id_idx ON site_settings (organization_id);

CREATE TRIGGER site_settings_set_updated_at
BEFORE UPDATE ON site_settings
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ---------------------------------------------------------------------------
-- sessions — server-side sessions (ADR-0013)
--
-- Deliberately NOT tenant-scoped: a session is looked up by token hash before any
-- organization is known, so tenant context cannot exist yet. Authorization for the
-- resolved user happens in the application layer (sub-phase 0.3/0.4).
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Hash only: the session token itself is never stored.
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- feature_flags — global platform configuration (not tenant data)
-- ---------------------------------------------------------------------------

CREATE TABLE feature_flags (
  id uuid PRIMARY KEY,
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9._-]{1,80}$'),
  description text NOT NULL,
  default_enabled boolean NOT NULL DEFAULT false,
  -- { "organization:<uuid>": bool, "site:<uuid>": bool }
  overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER feature_flags_set_updated_at
BEFORE UPDATE ON feature_flags
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ---------------------------------------------------------------------------
-- audit_logs — append-only record of consequential actions
--
-- organization_id intentionally carries NO foreign key: audit records outlive the
-- tenant they describe, including after a purge (docs/DATA-MODEL.md §12).
-- Append-only is enforced by grants in 0002 (no UPDATE/DELETE to runtime).
-- ---------------------------------------------------------------------------

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'system', 'worker')),
  actor_id text,
  action text NOT NULL CHECK (length(btrim(action)) BETWEEN 1 AND 200),
  target_type text NOT NULL,
  target_id text,
  before jsonb,
  after jsonb,
  source text NOT NULL CHECK (source IN ('ui', 'api', 'worker', 'wp_plugin', 'migration')),
  ip inet,
  result text NOT NULL CHECK (result IN ('ok', 'denied', 'error')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_organization_id_created_at_idx
  ON audit_logs (organization_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- integrations / integration_tokens — persistence shell only
--
-- No provider is connected in this phase. integration_tokens stores ciphertext and
-- key metadata; the envelope-encryption implementation arrives with sub-phase 0.6
-- (docs/SECURITY.md §5). Nothing here encrypts anything, and there is no column in
-- which a plaintext credential could be placed.
-- ---------------------------------------------------------------------------

CREATE TABLE integrations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  client_id uuid,
  site_id uuid,
  provider text NOT NULL CHECK (length(btrim(provider)) BETWEEN 1 AND 100),
  status integration_status NOT NULL DEFAULT 'connected',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_verified_at timestamptz,
  error_detail text,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  -- MATCH SIMPLE: the check is skipped when the optional column is NULL, and
  -- enforced against the same organization whenever it is set.
  FOREIGN KEY (client_id, organization_id)
    REFERENCES clients (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (site_id, organization_id)
    REFERENCES sites (id, organization_id) ON DELETE CASCADE
);

CREATE INDEX integrations_organization_id_idx ON integrations (organization_id);
CREATE INDEX integrations_organization_id_provider_idx
  ON integrations (organization_id, provider);

CREATE TRIGGER integrations_set_updated_at
BEFORE UPDATE ON integrations
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE integration_tokens (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  integration_id uuid NOT NULL,
  token_kind integration_token_kind NOT NULL,
  -- Ciphertext produced by the envelope-encryption layer (sub-phase 0.6).
  ciphertext bytea NOT NULL,
  key_version integer NOT NULL CHECK (key_version > 0),
  algo text NOT NULL CHECK (length(btrim(algo)) > 0),
  expires_at timestamptz,
  rotated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (integration_id, organization_id)
    REFERENCES integrations (id, organization_id) ON DELETE CASCADE
);

CREATE INDEX integration_tokens_organization_id_idx ON integration_tokens (organization_id);
CREATE INDEX integration_tokens_integration_id_idx ON integration_tokens (integration_id);
