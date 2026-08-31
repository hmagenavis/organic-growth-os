import { PROBLEM_CONTENT_TYPE, PROBLEM_TYPE_BASE_URL } from '@organic-os/contracts';
import type { ProblemDetails } from '@organic-os/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The external face of every authentication failure.
 *
 * There is exactly one credential-failure response, and it is identical whether the
 * address is unknown, has no credential set, or the password is wrong. Nothing here
 * exposes a hash, a session id, a database message or a stack trace
 * (docs/SECURITY.md §2, §8).
 */

function send(reply: FastifyReply, problem: ProblemDetails): void {
  reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

/** 401 — the single generic answer to any failed credential check. */
export function invalidCredentials(request: FastifyRequest, reply: FastifyReply): void {
  send(reply, {
    type: `${PROBLEM_TYPE_BASE_URL}invalid-credentials`,
    title: 'Invalid Credentials',
    status: 401,
    detail: 'Email or password is incorrect.',
    instance: request.url,
    requestId: String(request.id),
  });
}

/** 401 — no authentic session on a route that requires one. */
export function authenticationRequired(request: FastifyRequest, reply: FastifyReply): void {
  send(reply, {
    type: `${PROBLEM_TYPE_BASE_URL}authentication-required`,
    title: 'Authentication Required',
    status: 401,
    detail: 'A valid session is required.',
    instance: request.url,
    requestId: String(request.id),
  });
}

/** 403 — the CSRF token was absent, mismatched, or not one we issued. */
export function csrfRejected(request: FastifyRequest, reply: FastifyReply): void {
  send(reply, {
    type: `${PROBLEM_TYPE_BASE_URL}csrf-token-invalid`,
    title: 'CSRF Token Invalid',
    status: 403,
    // Deliberately does not say *which* of the checks failed.
    detail: 'A valid CSRF token is required for this request.',
    instance: request.url,
    requestId: String(request.id),
  });
}

/**
 * 429 — too many login attempts.
 *
 * Returned identically for existing and non-existing accounts, because the account
 * budget is consumed by failed attempts either way.
 */
export function tooManyLoginAttempts(
  request: FastifyRequest,
  reply: FastifyReply,
  retryAfterSeconds: number,
): void {
  reply.header('retry-after', String(retryAfterSeconds));
  send(reply, {
    type: `${PROBLEM_TYPE_BASE_URL}too-many-requests`,
    title: 'Too Many Requests',
    status: 429,
    detail: 'Too many login attempts. Try again later.',
    instance: request.url,
    requestId: String(request.id),
  });
}

/** 400 — the request body did not match the contract. Reports shape, never values. */
export function invalidRequestBody(request: FastifyRequest, reply: FastifyReply): void {
  send(reply, {
    type: `${PROBLEM_TYPE_BASE_URL}request`,
    title: 'Request Error',
    status: 400,
    detail: 'Request body is invalid.',
    instance: request.url,
    requestId: String(request.id),
  });
}
