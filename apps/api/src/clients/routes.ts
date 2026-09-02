import { isAuthorizationError, type AuthenticatedIdentityRef } from '@organic-os/authorization';
import {
  clientListQuerySchema,
  createClientRequestSchema,
  updateClientRequestSchema,
  type Client,
  type ClientListResponse,
  type ClientResponse,
} from '@organic-os/contracts';
import {
  isInvalidClientCursorError,
  type AdministrationRequest,
  type ClientService,
  type ClientView,
} from '@organic-os/database';
import type { Logger } from '@organic-os/observability';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { authenticationRequired } from '../auth/problems.js';
import { sendAuthorizationFailure } from '../authorization/problems.js';
import { invalidClientBody, invalidClientQuery } from './problems.js';

/**
 * The client API (Phase 0.4.2B1).
 *
 * Four routes, all organization-scoped:
 *
 *   GET    /organizations/:organizationId/clients
 *   GET    /organizations/:organizationId/clients/:clientId
 *   POST   /organizations/:organizationId/clients
 *   PATCH  /organizations/:organizationId/clients/:clientId
 *
 * There is deliberately no `DELETE`. Removing a client cascades into sites, site
 * settings and membership scopes today and into SEO state that does not exist yet,
 * so the lifecycle is designed in a later sub-phase rather than guessed at here.
 *
 * As in member administration, these handlers hold no policy and no SQL. Each one
 * authenticates, validates its input against the contract, and hands the request to
 * `ClientService`, which runs authorize → client scope → repository → audit inside
 * one authorized transaction. A handler cannot skip a step because there is no step
 * here to skip: nothing in this file can reach a repository, set a tenant context, or
 * observe the caller's role.
 *
 * Both path parameters are routing input. The organization id is verified against the
 * caller's persisted membership before anything else happens; the client id is
 * verified inside the authorized transaction against organization ownership *and* the
 * membership's client scope, so a client of another tenant and a client outside the
 * caller's scope are the same answer.
 *
 * CSRF is already enforced for every state-changing method by the authentication
 * plugin, so `POST` and `PATCH` here are covered without restating anything
 * (`auth/plugin.ts`).
 */

/** The identity authorization consumes. Nothing else from the session is passed on. */
function identityOf(request: FastifyRequest): AuthenticatedIdentityRef | null {
  const identity = request.auth.identity;
  return identity === null ? null : { userId: identity.user.id };
}

/**
 * Where the change came from, for the audit record.
 *
 * `request.ip` is the socket peer, because the app is built with `trustProxy: false`
 * — it cannot be forged with a header, which is what makes it worth recording.
 */
function clientRequest(request: FastifyRequest): AdministrationRequest {
  return { source: 'api', ip: request.ip };
}

/** Explicit projection: `ClientView` is already selected, and this keeps it that way. */
function toClient(view: ClientView): Client {
  return {
    id: view.id,
    name: view.name,
    status: view.status,
    industry: view.industry,
    notes: view.notes,
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
  };
}

export interface RegisterClientRoutesOptions {
  readonly clients: ClientService;
  readonly logger: Logger;
}

export function registerClientRoutes(
  app: FastifyInstance,
  options: RegisterClientRoutesOptions,
): void {
  const { clients, logger } = options;

  /**
   * Translates a refusal into its response.
   *
   * An `AuthorizationError` is answered by the non-enumerating mapping from sub-phase
   * 0.4.1 — 403 only about the caller's own role, 404 for everything it cannot reach.
   * A bad cursor is a request error and is answered as one, but only after
   * authorization has already succeeded, so it can never be used to probe. Anything
   * else is re-thrown, so a bug cannot degrade into a response that looks like a
   * policy decision.
   */
  function handleFailure(
    request: FastifyRequest,
    reply: FastifyReply,
    error: unknown,
    context: Record<string, string>,
  ): FastifyReply {
    if (isAuthorizationError(error)) {
      logger.warn(
        {
          requestId: String(request.id),
          method: request.method,
          url: request.url,
          failure: error.failure,
          ...(error.permission === undefined ? {} : { permission: error.permission }),
          ...(error.resource === undefined ? {} : { resource: error.resource }),
          ...context,
        },
        'authorization refused',
      );

      sendAuthorizationFailure(request, reply, error.failure);
      return reply;
    }

    if (isInvalidClientCursorError(error)) {
      invalidClientQuery(request, reply);
      return reply;
    }

    throw error;
  }

  app.get<{ Params: { organizationId: string } }>(
    '/organizations/:organizationId/clients',
    async (request, reply) => {
      const identity = identityOf(request);

      if (identity === null) {
        authenticationRequired(request, reply);
        return reply;
      }

      const parsed = clientListQuerySchema.safeParse(request.query);

      if (!parsed.success) {
        invalidClientQuery(request, reply);
        return reply;
      }

      try {
        const page = await clients.listClients(identity, request.params.organizationId, {
          limit: parsed.data.limit,
          ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
        });

        const body: ClientListResponse = {
          clients: page.clients.map(toClient),
          // No total count, deliberately: the only honest one is "rows this caller may
          // reach", and the organization's total would tell a scoped membership how
          // many clients exist outside its scope.
          page: { limit: page.limit, nextCursor: page.nextCursor },
        };

        reply.header('cache-control', 'no-store').code(200).send(body);
        return reply;
      } catch (error: unknown) {
        return handleFailure(request, reply, error, { userId: identity.userId });
      }
    },
  );

  app.get<{ Params: { organizationId: string; clientId: string } }>(
    '/organizations/:organizationId/clients/:clientId',
    async (request, reply) => {
      const identity = identityOf(request);

      if (identity === null) {
        authenticationRequired(request, reply);
        return reply;
      }

      try {
        const client = await clients.getClient(
          identity,
          request.params.organizationId,
          request.params.clientId,
        );

        const body: ClientResponse = { client: toClient(client) };

        reply.header('cache-control', 'no-store').code(200).send(body);
        return reply;
      } catch (error: unknown) {
        return handleFailure(request, reply, error, { userId: identity.userId });
      }
    },
  );

  app.post<{ Params: { organizationId: string } }>(
    '/organizations/:organizationId/clients',
    async (request, reply) => {
      const identity = identityOf(request);

      if (identity === null) {
        authenticationRequired(request, reply);
        return reply;
      }

      const parsed = createClientRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        invalidClientBody(request, reply);
        return reply;
      }

      try {
        const created = await clients.createClient(
          identity,
          request.params.organizationId,
          {
            name: parsed.data.name,
            ...(parsed.data.industry === undefined ? {} : { industry: parsed.data.industry }),
            ...(parsed.data.notes === undefined ? {} : { notes: parsed.data.notes }),
          },
          clientRequest(request),
        );

        const body: ClientResponse = { client: toClient(created) };

        reply.header('cache-control', 'no-store').code(201).send(body);
        return reply;
      } catch (error: unknown) {
        return handleFailure(request, reply, error, { userId: identity.userId });
      }
    },
  );

  app.patch<{ Params: { organizationId: string; clientId: string } }>(
    '/organizations/:organizationId/clients/:clientId',
    async (request, reply) => {
      const identity = identityOf(request);

      if (identity === null) {
        authenticationRequired(request, reply);
        return reply;
      }

      const parsed = updateClientRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        invalidClientBody(request, reply);
        return reply;
      }

      try {
        const updated = await clients.updateClient(
          identity,
          request.params.organizationId,
          request.params.clientId,
          {
            ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
            ...(parsed.data.industry === undefined ? {} : { industry: parsed.data.industry }),
            ...(parsed.data.notes === undefined ? {} : { notes: parsed.data.notes }),
          },
          clientRequest(request),
        );

        const body: ClientResponse = { client: toClient(updated) };

        reply.header('cache-control', 'no-store').code(200).send(body);
        return reply;
      } catch (error: unknown) {
        return handleFailure(request, reply, error, { userId: identity.userId });
      }
    },
  );
}
