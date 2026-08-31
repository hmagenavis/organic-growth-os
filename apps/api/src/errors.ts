import {
  PROBLEM_CONTENT_TYPE,
  PROBLEM_TYPE_BASE_URL,
  type ProblemDetails,
} from '@organic-os/contracts';
import type { Logger } from '@organic-os/observability';
import type { FastifyInstance, FastifyReply } from 'fastify';

function sendProblem(reply: FastifyReply, problem: ProblemDetails): void {
  reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

/**
 * Fastify types the error handler's error as `unknown`, and a thrown value need not be
 * an Error at all, so both helpers narrow defensively.
 */
function statusFrom(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const { statusCode } = error;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 599) {
      return statusCode;
    }
  }

  return 500;
}

function describeError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: 'unknown error' };
}

/**
 * Installs the single error shape for the API: RFC 9457 problem details.
 *
 * Internal failures (5xx) are logged in full server-side and reported to the client
 * without any diagnostic detail — no stack traces, no provider payloads, no SQL
 * (docs/SECURITY.md §8).
 */
export function registerErrorHandlers(app: FastifyInstance, logger: Logger): void {
  app.setNotFoundHandler((request, reply) => {
    sendProblem(reply, {
      type: `${PROBLEM_TYPE_BASE_URL}not-found`,
      title: 'Not Found',
      status: 404,
      instance: request.url,
      requestId: String(request.id),
    });
  });

  app.setErrorHandler((error, request, reply) => {
    const status = statusFrom(error);
    const described = describeError(error);

    logger.error(
      {
        requestId: String(request.id),
        method: request.method,
        url: request.url,
        statusCode: status,
        errorName: described.name,
        errorMessage: described.message,
      },
      'request failed',
    );

    if (status >= 500) {
      sendProblem(reply, {
        type: `${PROBLEM_TYPE_BASE_URL}internal`,
        title: 'Internal Server Error',
        status,
        instance: request.url,
        requestId: String(request.id),
      });
      return;
    }

    sendProblem(reply, {
      type: `${PROBLEM_TYPE_BASE_URL}request`,
      title: 'Request Error',
      status,
      detail: described.message,
      instance: request.url,
      requestId: String(request.id),
    });
  });
}
