import { PROBLEM_CONTENT_TYPE, PROBLEM_TYPE_BASE_URL } from '@organic-os/contracts';
import type { ProblemDetails } from '@organic-os/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The two request-shape refusals the client API can produce on its own.
 *
 * Everything about *authorization* is next door in `authorization/problems.ts` and
 * stays there: a client the caller cannot reach — absent, another tenant's, or
 * outside its client scope — is one byte-identical 404 produced by that mapping, and
 * nothing here may add a distinguishing detail to it.
 *
 * These two are safe to state plainly because neither depends on tenant state. A
 * malformed body and a malformed query string are refused the same way whichever
 * organization or client id the URL names, so no answer here can be compared against
 * another to learn what exists.
 */

function send(reply: FastifyReply, problem: ProblemDetails): void {
  reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

/** 400 — the request body did not match the contract. Reports shape, never values. */
export function invalidClientBody(request: FastifyRequest, reply: FastifyReply): void {
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
 * position this ordering can resume from. Over-limit is a refusal rather than a
 * silent clamp: a caller that asked for 1000 and received 100 cannot tell that from
 * an organization that has exactly 100 clients.
 */
export function invalidClientQuery(request: FastifyRequest, reply: FastifyReply): void {
  send(reply, {
    type: `${PROBLEM_TYPE_BASE_URL}request`,
    title: 'Request Error',
    status: 400,
    detail: 'Query parameters are invalid.',
    instance: request.url,
    requestId: String(request.id),
  });
}
