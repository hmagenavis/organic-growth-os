import { PERMISSIONS, type Permission } from './permissions.js';
import { ORGANIZATION_ROLES, type OrganizationRole } from './roles.js';

/**
 * The permission matrix, versioned, in code, as data.
 *
 * It is not database-configurable and will not become so in Phase 0: a matrix that
 * can be edited at runtime cannot be reviewed in a diff, cannot be covered by a
 * table-driven test, and turns every role row into a privilege-escalation target.
 * Changing authorization here is a code change that goes through review and CI
 * (docs/SECURITY.md §3).
 *
 * ## How the rows were derived
 *
 * SECURITY.md §3 is the source of truth. Its matrix speaks in capabilities
 * ("Manage org, members, budgets", "View analytics/opportunities"), most of which
 * belong to features later phases build. The Phase-0 permissions that map cleanly:
 *
 *   * "Manage org, members, budgets" → agency_admin only. Every `member.*`
 *     permission and `session.revoke_member` follow from it.
 *   * "View analytics/opportunities" → all five roles, client_viewer restricted to
 *     its scoped clients. `client.read` and `site.read` are the Phase-0 shape of
 *     that row; the client restriction is enforced separately, by client access mode
 *     (see `client-access.ts`), because a role check alone cannot express it.
 *
 * ## Deliberate denials where the planning documents are silent
 *
 * SECURITY.md does not say who may create or edit clients and sites. Rather than
 * guess, this registry denies `client.create`, `client.update`, `site.create` and
 * `site.update` to every role except agency_admin, and denies `member.read` to every
 * role except agency_admin. Widening a permission later is a one-line change with a
 * test; discovering that seo_manager could silently create clients is an incident.
 *
 * Sub-phase 0.4.2A closed one of the two open questions from
 * docs/phases/PHASE-0.4.1-IMPLEMENTATION.md §4: **`member.read` stays agency_admin
 * only**, because the member list is administrative data rather than a directory, and
 * every `member.*` mutation is agency_admin only alongside it.
 *
 * Sub-phase 0.4.2B1 closed the other one, conservatively: **`client.create` and
 * `client.update` stay agency_admin only**, and every other role holds `client.read`
 * alone. seo_manager does not get client writes yet. The endpoints that consume these
 * permissions now exist, so the decision is testable rather than hypothetical, and
 * widening it later is a one-line change with a table-driven test behind it —
 * whereas shipping a write permission nobody asked for and discovering it in
 * production is an incident. The `site.*` writes stay agency_admin only for the same
 * reason, until the sub-phase that builds the sites API.
 *
 * Sub-phase 0.4.2B2 built that API and **kept the rows exactly as they are**:
 * `site.create` and `site.update` remain agency_admin only, and seo_manager,
 * content_editor, analyst and client_viewer hold `site.read` alone. This is the
 * written decision 0.4.2B1 §19.6 asked for. The argument for widening it was that
 * seo_manager will manage a site's integrations under docs/SECURITY.md §3; the
 * argument against, which won, is that authority over a *connection* does not imply
 * authority over the structural resource the connection hangs off. Creating a site
 * establishes a new tenant object with its own settings row and its own execution
 * policy, and re-pointing a site's `base_url` re-points every future crawl, snapshot
 * and published change at a different property. Neither is integration management.
 * If the integration sub-phase needs seo_manager to act, the permission it needs is
 * `integration.*`, not `site.update`.
 *
 * Note that none of 0.4.2A, 0.4.2B1 or 0.4.2B2 changed any role's permissions, which
 * is why `PERMISSION_REGISTRY_VERSION` is unchanged: bumping it would claim a change
 * that did not happen.
 *
 * ## Versioning
 *
 * `PERMISSION_REGISTRY_VERSION` is stamped onto every authorization context, so a
 * log line or an audit row states which matrix produced a decision. Bump it whenever
 * a role's permissions change.
 */
export const PERMISSION_REGISTRY_VERSION = 1;

/** Read access every role holds. client_viewer is additionally client-restricted. */
const BASE_READ: readonly Permission[] = [
  'organization.read',
  'client.read',
  'site.read',
  'session.read_own',
  'session.revoke_own',
];

const MATRIX: Readonly<Record<OrganizationRole, readonly Permission[]>> = Object.freeze({
  // Administrative authority inside its own organization — and nothing beyond it.
  // Platform-level operations are not reachable from any organization role.
  agency_admin: PERMISSIONS,
  seo_manager: BASE_READ,
  content_editor: BASE_READ,
  analyst: BASE_READ,
  client_viewer: BASE_READ,
});

const COMPILED: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  ORGANIZATION_ROLES.map((role) => [role, new Set<string>(MATRIX[role])]),
);

/**
 * The single authorization predicate for role-derived permissions.
 *
 * Deny-by-default in the literal sense: the answer comes from a set built out of the
 * matrix above, so anything not listed — an unknown role, an unknown permission, a
 * permission a role was never granted — is false. There is no fallback branch that
 * could return true.
 *
 * A client-scoped resource additionally requires `clientAccessAllows`; this function
 * is never sufficient on its own for one (docs/SECURITY.md §3).
 */
export function can(role: unknown, permission: unknown): boolean {
  if (typeof role !== 'string' || typeof permission !== 'string') {
    return false;
  }

  return COMPILED.get(role)?.has(permission) ?? false;
}

/** The permissions a role holds, for tests, documentation and admin UIs. */
export function permissionsForRole(role: OrganizationRole): readonly Permission[] {
  return MATRIX[role];
}
