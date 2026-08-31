-- 0003_authentication.sql
-- Phase 0.3 — what authentication needs from the database, and nothing more.
--
-- Runs as the MIGRATION role (organic_os_migrator). Forward-only: 0001 and 0002 are
-- applied and immutable, so every change here is additive.
--
-- Two things are added:
--
--   1. session lifecycle columns (last_used_at, revoked_at) — idle expiry and
--      explicit revocation cannot be expressed with expires_at alone;
--   2. an authentication lookup path on `users` for the runtime role.
--
-- (2) needs explaining, because 0002 deliberately made `users` unreadable without a
-- tenant context. Authentication happens *before* any organization is known: at login
-- there is only an email address, and when resolving a session there is only a token
-- hash. `sessions` was already left outside RLS for exactly this reason; `users` could
-- not be, because it is also organization-directory data.
--
-- The path added here is therefore a *point lookup*, not an exemption. The policy
-- matches only the row whose email or id the caller already supplied through a
-- transaction-local setting. There is no predicate under which it returns more than
-- one row, so it cannot be used to enumerate users, and with no setting established
-- it matches nothing at all — the same fail-closed shape as app.current_org_id().
--
-- Crucially this grants no tenant access: `app.auth_email` / `app.auth_user_id` are
-- separate settings from `app.current_org_id`, and establishing them does not
-- establish a tenant context. Authentication still proves only identity
-- (docs/SECURITY.md §2 vs §3/§4).

-- ---------------------------------------------------------------------------
-- sessions — lifecycle columns
-- ---------------------------------------------------------------------------

-- Idle expiry. Existing rows (there are none in any environment yet, but the
-- migration must be correct regardless) inherit their creation time.
ALTER TABLE sessions ADD COLUMN last_used_at timestamptz NOT NULL DEFAULT now();
UPDATE sessions SET last_used_at = created_at;

-- Explicit revocation: logout, rotation, idle expiry, and the administrative
-- revocation primitives. Revoking is a write, not a delete, so a revoked session
-- stays visible to incident review until the cleanup command collects it.
ALTER TABLE sessions ADD COLUMN revoked_at timestamptz;

COMMENT ON COLUMN sessions.last_used_at IS
  'Last request that presented this session. Drives the idle timeout.';
COMMENT ON COLUMN sessions.revoked_at IS
  'Set on logout, rotation, idle expiry or administrative revocation. NULL while live.';

-- Supports the cleanup command, which deletes finished sessions by when they ended.
CREATE INDEX sessions_revoked_at_idx ON sessions (revoked_at) WHERE revoked_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Authentication lookup context
--
-- Same construction as app.current_org_id(): read a transaction-local setting,
-- return NULL when unset so every comparison yields NULL and matches no rows.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.auth_email() RETURNS citext
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('app.auth_email', true), '')::citext
$$;

COMMENT ON FUNCTION app.auth_email() IS
  'Transaction-local email being authenticated. NULL when unset so the policy fails closed.';

CREATE OR REPLACE FUNCTION app.auth_user_id() RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('app.auth_user_id', true), '')::uuid
$$;

COMMENT ON FUNCTION app.auth_user_id() IS
  'Transaction-local user id being authenticated. NULL when unset so the policy fails closed.';

GRANT EXECUTE ON FUNCTION app.auth_email() TO organic_os_runtime;
GRANT EXECUTE ON FUNCTION app.auth_user_id() TO organic_os_runtime;

-- ---------------------------------------------------------------------------
-- users — authentication policies
--
-- These are additional PERMISSIVE policies: they OR with users_read_same_organization
-- from 0002, which is unchanged. A request either has a tenant context (directory
-- read) or an authentication context (point lookup) — never both, because the
-- application establishes them in separate transactions through separate entry
-- points.
-- ---------------------------------------------------------------------------

CREATE POLICY users_authentication_lookup ON users
  FOR SELECT TO organic_os_runtime
  USING (email = app.auth_email() OR id = app.auth_user_id());

-- Recording a successful login. The USING/WITH CHECK pair pins the row to the user
-- being authenticated, and the column-scoped grant below means this statement can
-- physically only write last_login_at: password_hash, email and is_platform_admin are
-- unreachable from the runtime role no matter what SQL it issues.
CREATE POLICY users_authentication_touch ON users
  FOR UPDATE TO organic_os_runtime
  USING (id = app.auth_user_id())
  WITH CHECK (id = app.auth_user_id());

GRANT UPDATE (last_login_at) ON users TO organic_os_runtime;
