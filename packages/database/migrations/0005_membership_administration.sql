-- 0005_membership_administration.sql
-- Phase 0.4.2A — what member administration needs from the database, and nothing more.
--
-- Runs as the MIGRATION role (organic_os_migrator). Forward-only: 0001–0004 are
-- applied and immutable, so every change here is additive.
--
-- Exactly one change is made, and it is deliberately small. Everything else this
-- sub-phase needs already exists:
--
--   * membership mutation           memberships already carries INSERT/UPDATE/DELETE
--                                   grants for the runtime role under
--                                   memberships_tenant_isolation (0002);
--   * client scope replacement      membership_client_scopes likewise, with composite
--                                   foreign keys that make a cross-organization scope
--                                   structurally impossible (0001);
--   * the last-admin lock           SELECT ... FOR UPDATE needs no schema support; the
--                                   runtime role already holds UPDATE on memberships,
--                                   and memberships_organization_id_idx (0001) already
--                                   serves the predicate. No index is added for a
--                                   lookup over the memberships of one organization.
--   * session revocation            sessions is intentionally outside RLS (0002) and
--                                   the runtime role already holds UPDATE on it, which
--                                   is what lets a membership mutation and the
--                                   revocation it forces commit in ONE transaction
--                                   (ADR-0017).
--   * the tenant audit trail        audit_logs already exists, is append-only by
--                                   privilege (SELECT + INSERT only, no UPDATE, no
--                                   DELETE) and is tenant-scoped (0002).
--
-- No FORCE ROW LEVEL SECURITY is lifted here. 0004 had to, for a backfill the
-- migrator could not otherwise perform; this migration adds a nullable column with no
-- backfill, so there is nothing to relax. Temporarily lifting FORCE is not a pattern —
-- it is a documented exception that has to justify itself each time
-- (docs/phases/PHASE-0.4.1-IMPLEMENTATION.md §12).

-- ---------------------------------------------------------------------------
-- audit_logs.actor_membership_id
--
-- audit_logs.actor_id already records *who* acted. This records the membership they
-- acted through, which is a different fact and not reliably derivable later: a
-- membership can be removed and re-created for the same (user, organization) pair,
-- and once it has been, "the membership this user held at the time" is gone. An audit
-- trail whose subject is membership administration has to be able to name it.
--
-- Nullable, because it genuinely is absent for some legitimate writers: a worker or
-- a system actor holds no membership. No foreign key, for the same reason
-- organization_id has none — audit records outlive the rows they describe, and a
-- cascade from memberships would delete the history of a removal along with the
-- membership it recorded.
--
-- The table-level SELECT/INSERT grants from 0002 cover the new column, and
-- audit_logs_tenant_append is unchanged: an audit row is still writable only with
-- organization_id = app.current_org_id().
-- ---------------------------------------------------------------------------

ALTER TABLE audit_logs ADD COLUMN actor_membership_id uuid;

COMMENT ON COLUMN audit_logs.actor_membership_id IS
  'Membership the actor acted through, when there was one. No FK: audit records outlive the memberships they describe, and a removal must not delete its own audit row.';
