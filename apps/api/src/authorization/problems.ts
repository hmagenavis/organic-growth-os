import { PROBLEM_CONTENT_TYPE, PROBLEM_TYPE_BASE_URL } from '@organic-os/contracts';
import type { ProblemDetails } from '@organic-os/contracts';
import type { AuthorizationFailure } from '@organic-os/authorization';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The external face of an authorization failure.
 *
 * Two responses, and the mapping between them is the sub-phase's non-enumeration
 * decision:
 *
 * | Internal failure               | Response | Why |
 * |--------------------------------|----------|-----|
 * | (no session)                   | 401      | Authentication is missing; saying so is not a leak — the caller already knows whether it sent a session. |
 * | `permission_denied`            | 403      | The caller is a proven member; refusing by role reveals only the caller's own role, which it may already read from `GET /auth/organizations`. |
 * | `no_membership`                | 404      | Saying "forbidden" would confirm the organization exists. A caller must not be able to enumerate organizations by probing ids. |
 * | `malformed_organization_id`    | 404      | Answered identically to a miss, so a well-formed id and a malformed one are indistinguishable. |
 * | `resource_not_in_organization` | 404      | A client of another tenant is indistinguishable from one that does not exist. |
 * | `client_out_of_scope`          | 404      | A scoped membership must not be able to discover which clients exist outside its scope by comparing 403 against 404. |
 *
 * The rule underneath: **403 may only be returned once the caller is known to be a
 * member of the organization in question, and only about the caller's own role.**
 * Everything about a resource the caller cannot reach is a 404.
 *
 * The cost is real and accepted: a member who genuinely lacks access to one client
 * sees "not found" rather than "forbidden". The alternative hands anyone with any
 * membership a working oracle for other tenants' resource ids.
 */

function send(reply: FastifyReply, problem: ProblemDetails): void {
  reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

/** 403 — a proven member whose role does not hold the required permission. */
export function permissionDenied(request: FastifyRequest, reply: FastifyReply): void {
  send(reply, {
    type: `${PROBLEM_TYPE_BASE_URL}permission-denied`,
    title: 'Permission Denied',
    status: 403,
    // Deliberately does not name the permission: the caller learns that this action
    // is not available to it, not the shape of the permission vocabulary.
    detail: 'Your role does not allow this action.',
    instance: request.url,
    requestId: String(request.id),
  });
}

/**
 * 404 — the resource is not reachable by this caller.
 *
 * Returned identically whether it does not exist, belongs to another organization, or
 * lies outside the caller's client scope.
 */
export function resourceNotFound(request: FastifyRequest, reply: FastifyReply): void {
  send(reply, {
    type: `${PROBLEM_TYPE_BASE_URL}not-found`,
    title: 'Not Found',
    status: 404,
    detail: 'The requested resource does not exist or is not available.',
    instance: request.url,
    requestId: String(request.id),
  });
}

/** Maps an authorization failure onto its response. Exhaustive by construction. */
export function sendAuthorizationFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  failure: AuthorizationFailure,
): void {
  if (failure === 'permission_denied') {
    permissionDenied(request, reply);
    return;
  }

  resourceNotFound(request, reply);
}
