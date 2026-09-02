import { PROBLEM_CONTENT_TYPE, PROBLEM_TYPE_BASE_URL } from '@organic-os/contracts';
import type { ProblemDetails } from '@organic-os/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The request-shape and conflict refusals the site API produces on its own.
 *
 * Everything about *authorization* is in `authorization/problems.ts` and stays there:
 * a client the caller cannot reach, and a site that does not exist, belongs to another
 * organization, hangs off another client, or sits under a client outside the caller's
 * scope, are one byte-identical 404 produced by that mapping. Nothing here may add a
 * distinguishing detail to it.
 */

function send(reply: FastifyReply, problem: ProblemDetails): void {
  reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

/**
 * 400 — the request body did not match the contract, or a value in it could not be
 * normalized.
 *
 * Reports shape, never values: the rejected base URL, time zone or language tag is
 * caller input, and echoing it into a response body is how a validation message
 * becomes a reflection vector. The reason is logged instead.
 */
export function invalidSiteBody(request: FastifyRequest, reply: FastifyReply): void {
  send(reply, {
    type: `${PROBLEM_TYPE_BASE_URL}request`,
    title: 'Request Error',
    status: 400,
    detail: 'Request body is invalid.',
    instance: request.url,
    requestId: String(request.id),
  });
}

/**
 * 400 — the query string did not match the contract.
 *
 * Covers an out-of-range `limit`, an unknown parameter, and a `cursor` that is not a
 * position this ordering can resume from.
 */
export function invalidSiteQuery(request: FastifyRequest, reply: FastifyReply): void {
  send(reply, {
    type: `${PROBLEM_TYPE_BASE_URL}request`,
    title: 'Request Error',
    status: 400,
    detail: 'Query parameters are invalid.',
    instance: request.url,
    requestId: String(request.id),
  });
}

/**
 * 409 — the organization already has a site with this base URL.
 *
 * Raised by `UNIQUE (organization_id, base_url)` rather than by a preflight `SELECT`,
 * so two simultaneous creates cannot both succeed.
 *
 * The constraint is organization-wide, so this can be provoked by a URL held under a
 * client the caller cannot reach. That disclosure is deliberate and bounded: the
 * response names no client, no site and no id — only that the organization already
 * uses the URL — and only a caller who has already proven `agency_admin` membership of
 * that organization can reach this code path at all. Answering 201 or 404 instead
 * would either violate the constraint or lie about what happened.
 */
export function siteBaseUrlConflict(request: FastifyRequest, reply: FastifyReply): void {
  send(reply, {
    type: `${PROBLEM_TYPE_BASE_URL}conflict`,
    title: 'Conflict',
    status: 409,
    detail: 'A site with this base URL already exists in this organization.',
    instance: request.url,
    requestId: String(request.id),
  });
}
