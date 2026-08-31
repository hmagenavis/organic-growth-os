import type { ClientAccessMode } from './client-access.js';
import type { OrganizationRole } from './roles.js';

/**
 * The policy half of member administration.
 *
 * Everything here is a pure decision over values: no SQL, no transaction, no HTTP.
 * The orchestration that locks rows, writes them, revokes sessions and appends audit
 * records lives in `@organic-os/database`
 * (`src/administration/membership-administration.ts`), for the same reason
 * `withAuthorizedOrganization` does — that package owns transactions, this one owns
 * policy (ADR-0011).
 *
 * Keeping the decisions here means each is a table-testable function rather than a
 * branch buried inside a transaction, and that the rules below hold for any future
 * caller, not only for the HTTP routes that exist today.
 */

/**
 * Why member administration refused.
 *
 * These are *domain* refusals by a caller who is a proven agency admin of the
 * organization. They are distinct from `AuthorizationFailure`, which covers "you are
 * not a member", "your role does not hold this permission" and "that resource is not
 * reachable" — the cases whose responses must stay non-enumerating. A caller that
 * sees one of these has already proven it may administer this organization, so
 * naming the invariant it hit leaks nothing it could not discover by reading the
 * member list it is entitled to read.
 */
export type MembershipAdministrationFailure =
  /** The caller aimed a mutation at its own membership. */
  | 'self_mutation_forbidden'
  /** The change would leave the organization with no agency admin. */
  | 'last_agency_admin'
  /** The user already holds a membership in this organization. */
  | 'membership_already_exists'
  /** No platform account exists for that address, and invitations do not exist yet. */
  | 'user_not_registered'
  /** `client_viewer` is client-restricted by definition; `all_clients` is not offerable. */
  | 'client_viewer_requires_scoped';

/** A refusal by member administration policy. The message is for logs, never a body. */
export class MembershipAdministrationError extends Error {
  readonly failure: MembershipAdministrationFailure;

  constructor(failure: MembershipAdministrationFailure) {
    super(`Member administration refused: ${failure}`);
    this.name = 'MembershipAdministrationError';
    this.failure = failure;
  }
}

export function isMembershipAdministrationError(
  value: unknown,
): value is MembershipAdministrationError {
  return value instanceof MembershipAdministrationError;
}

/** A membership's client-level reach, as a value. */
export interface ClientAccessState {
  readonly mode: ClientAccessMode;
  /** Meaningful only when `mode` is `scoped`; empty then means zero clients. */
  readonly clientIds: ReadonlySet<string>;
}

/**
 * An administrator may not aim a membership mutation at their own membership.
 *
 * The rule is deliberately blunt — *any* self-targeted role change, scope change or
 * removal — rather than an attempt to allow the "harmless" directions:
 *
 *   * raising one's own role is a privilege escalation with no second party;
 *   * widening one's own client access is the same escalation at client level;
 *   * lowering or removing one's own agency-admin membership is how an organization
 *     accidentally loses its last administrator through a UI mis-click, and the
 *     last-admin check alone would not catch it while a second admin exists.
 *
 * Narrowing yourself is safe in isolation, but allowing it means the endpoint has to
 * decide direction on every call, and a direction check is exactly the thing that is
 * wrong once — so it is refused too. A deliberate "leave organization" workflow is a
 * later, separate decision (§6 of the sub-phase brief).
 */
export function assertNotSelfMutation(actorMembershipId: string, targetMembershipId: string): void {
  if (actorMembershipId === targetMembershipId) {
    throw new MembershipAdministrationError('self_mutation_forbidden');
  }
}

export interface AgencyAdminInvariantInput {
  /**
   * Every `agency_admin` membership of the organization, as observed under a lock
   * held for the rest of the transaction. The lock is what makes this check
   * concurrency-safe; this function only does the arithmetic.
   */
  readonly agencyAdminMembershipIds: readonly string[];
  readonly targetMembershipId: string;
  /** Whether the target is still an agency admin after the change. */
  readonly targetRemainsAgencyAdmin: boolean;
}

/**
 * The organization must never commit a state with zero agency admins.
 *
 * Counted rather than compared against 1, so the check is correct whether the target
 * is currently an admin or not: removing a `seo_manager` leaves the admin count
 * untouched and is always allowed.
 *
 * @throws {MembershipAdministrationError} `last_agency_admin`
 */
export function assertAgencyAdminRemains(input: AgencyAdminInvariantInput): void {
  const others = input.agencyAdminMembershipIds.filter(
    (membershipId) => membershipId !== input.targetMembershipId,
  ).length;

  const remaining = others + (input.targetRemainsAgencyAdmin ? 1 : 0);

  if (remaining < 1) {
    throw new MembershipAdministrationError('last_agency_admin');
  }
}

/**
 * `client_viewer` is client-restricted by definition (docs/SECURITY.md §3), and the
 * database enforces it with a CHECK constraint. This is the same rule stated where a
 * request can be refused with an explanation instead of a constraint violation.
 *
 * @throws {MembershipAdministrationError} `client_viewer_requires_scoped`
 */
export function assertClientAccessAllowedForRole(
  role: OrganizationRole,
  mode: ClientAccessMode,
): void {
  if (role === 'client_viewer' && mode === 'all_clients') {
    throw new MembershipAdministrationError('client_viewer_requires_scoped');
  }
}

/**
 * The client access a membership must end up with after a role change.
 *
 * Only one transition invalidates existing access semantics: becoming a
 * `client_viewer` while holding `all_clients`, which the CHECK constraint forbids.
 * Rather than refusing the role change, it is normalised **atomically and in the
 * narrowing direction** — `scoped` with an empty scope collection, i.e. zero clients
 * — so the demotion always succeeds and never widens anything. The administrator
 * then grants clients deliberately through the scope endpoint.
 *
 * Every other transition leaves client access exactly as it was. In particular a
 * role change never converts `scoped` into `all_clients`: broadening is only ever an
 * explicit act (§4 of the sub-phase brief).
 */
export function normalizeClientAccessForRole(
  role: OrganizationRole,
  current: ClientAccessState,
): ClientAccessState {
  if (role === 'client_viewer' && current.mode === 'all_clients') {
    return { mode: 'scoped', clientIds: new Set<string>() };
  }

  return current;
}

/**
 * Whether client access got strictly smaller.
 *
 * Drives forced session revocation: a membership that can now reach fewer clients
 * than it could a moment ago must not keep browser sessions that were established
 * under the wider access, even though authorization is re-proven per request.
 *
 *   all_clients → all_clients   no change
 *   all_clients → scoped        narrowing, always — `scoped` is a subset by
 *                               construction, including the empty one
 *   scoped      → all_clients   broadening
 *   scoped      → scoped        narrowing when any previously listed client is gone
 *
 * Broadening deliberately does not revoke: nothing that was permitted stops being
 * permitted, and every request re-reads the membership anyway, so the new access
 * takes effect immediately without disrupting the member's session (§8 of the
 * sub-phase brief).
 */
export function isClientAccessNarrowing(
  before: ClientAccessState,
  after: ClientAccessState,
): boolean {
  if (before.mode === 'all_clients') {
    return after.mode === 'scoped';
  }

  if (after.mode === 'all_clients') {
    return false;
  }

  for (const clientId of before.clientIds) {
    if (!after.clientIds.has(clientId)) {
      return true;
    }
  }

  return false;
}
