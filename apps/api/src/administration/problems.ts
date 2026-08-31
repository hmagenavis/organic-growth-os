import { PROBLEM_CONTENT_TYPE, PROBLEM_TYPE_BASE_URL } from '@organic-os/contracts';
import type { ProblemDetails } from '@organic-os/contracts';
import type { MembershipAdministrationFailure } from '@organic-os/authorization';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The external face of a member-administration refusal.
 *
 * These responses are *more* specific than the authorization ones next door, and the
 * asymmetry is deliberate rather than an oversight.
 *
 * `authorization/problems.ts` collapses four internal failures into one 404 because
 * each of them concerns a resource the caller has not proven it may see, and telling
 * them apart would turn the boundary into an existence oracle. Nothing here is in
 * that position: every response below is reachable only *after* the caller has
 * proven an `agency_admin` membership in the organization it is administering, and
 * every fact they reveal — that an organization has one administrator left, that a
 * user already holds a membership, that a caller aimed at their own row — is a fact
 * that caller can read directly from the member list it is entitled to read.
 *
 * A refusal an administrator cannot understand is a refusal they will work around,
 * so each one names the invariant it hit:
 *
 * | Failure | Response | Code |
 * |---|---|---|
 * | `self_mutation_forbidden`      | 409 | `SELF_MUTATION_FORBIDDEN` |
 * | `last_agency_admin`            | 409 | `LAST_AGENCY_ADMIN` |
 * | `membership_already_exists`    | 409 | `MEMBERSHIP_ALREADY_EXISTS` |
 * | `client_viewer_requires_scoped`| 409 | `CLIENT_VIEWER_REQUIRES_SCOPED` |
 * | `user_not_registered`          | 422 | `INVITATION_FLOW_NOT_IMPLEMENTED` |
 *
 * 409 for the first four: the request is well-formed and the caller is entitled to
 * make it, but the organization's current state refuses it. 422 for the last,
 * because that request is not refused at all — it names a workflow this build does
 * not have. Saying so is the honest answer; the alternative, creating an account
 * with a password nobody chose, is not (§3 of the sub-phase brief).
 *
 * Anything about a membership the caller cannot reach — another tenant's, or one
 * that does not exist — never arrives here. It is an `AuthorizationError` and gets
 * the same byte-identical 404 as every other unreachable resource.
 */

function send(reply: FastifyReply, problem: ProblemDetails): void {
  reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

interface FailureResponse {
  readonly status: number;
  readonly slug: string;
  readonly title: string;
  readonly code: string;
  readonly detail: string;
}

const RESPONSES: Readonly<Record<MembershipAdministrationFailure, FailureResponse>> = Object.freeze(
  {
    self_mutation_forbidden: {
      status: 409,
      slug: 'self-mutation-forbidden',
      title: 'Self Mutation Forbidden',
      code: 'SELF_MUTATION_FORBIDDEN',
      detail:
        'You cannot change or remove your own membership. Ask another agency admin to make this change.',
    },
    last_agency_admin: {
      status: 409,
      slug: 'last-agency-admin',
      title: 'Last Agency Admin',
      code: 'LAST_AGENCY_ADMIN',
      detail:
        'An organization must always have at least one agency admin. Promote another member first.',
    },
    membership_already_exists: {
      status: 409,
      slug: 'membership-already-exists',
      title: 'Membership Already Exists',
      code: 'MEMBERSHIP_ALREADY_EXISTS',
      detail: 'That user is already a member of this organization.',
    },
    client_viewer_requires_scoped: {
      status: 409,
      slug: 'client-viewer-requires-scoped',
      title: 'Client Viewer Requires Scoped Access',
      code: 'CLIENT_VIEWER_REQUIRES_SCOPED',
      detail: 'A client viewer must be restricted to specific clients.',
    },
    user_not_registered: {
      status: 422,
      slug: 'invitation-flow-not-implemented',
      title: 'Invitation Flow Not Implemented',
      code: 'INVITATION_FLOW_NOT_IMPLEMENTED',
      detail:
        'No account exists for that address, and sending invitations is not implemented yet. ' +
        'The account must be provisioned before it can be added to an organization.',
    },
  },
);

/** Maps a member-administration failure onto its response. Exhaustive by construction. */
export function sendMembershipAdministrationFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  failure: MembershipAdministrationFailure,
): void {
  const response = RESPONSES[failure];

  send(reply, {
    type: `${PROBLEM_TYPE_BASE_URL}${response.slug}`,
    title: response.title,
    status: response.status,
    detail: response.detail,
    instance: request.url,
    requestId: String(request.id),
    code: response.code,
  });
}

/** 400 — the request body did not match the contract. Reports shape, never values. */
export function invalidAdministrationBody(request: FastifyRequest, reply: FastifyReply): void {
  send(reply, {
    type: `${PROBLEM_TYPE_BASE_URL}request`,
    title: 'Request Error',
    status: 400,
    detail: 'Request body is invalid.',
    instance: request.url,
    requestId: String(request.id),
  });
}
