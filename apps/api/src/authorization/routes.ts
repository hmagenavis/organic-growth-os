import {
  isAuthorizationError,
  permissionsForRole,
  type AuthenticatedIdentityRef,
} from '@organic-os/authorization';
import type { AuthorizationService, AuthorizedOrganizationSession } from '@organic-os/database';
import {
  organizationRoleSchema,
  clientAccessModeSchema,
  type OrganizationListResponse,
  type OrganizationResponse,
} from '@organic-os/contracts';
import type { Logger } from '@organic-os/observability';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { authenticationRequired } from '../auth/problems.js';
import { resourceNotFound, sendAuthorizationFailure } from './problems.js';

/**
 * The authorization surface of Phase 0.4.1.
 *
 * Two routes, which together are the whole pipeline once:
 *
 *   * `GET /auth/organizations` — what the caller may choose between. Runs the
 *     membership bootstrap and nothing else; establishes no tenant context.
 *   * `GET /organizations/:organizationId` — the caller's explicit choice, verified.
 *     The path parameter is routing input; the response is built from the membership
 *     row it resolves to.
 *
 * There is no clients API, no sites API and no member-mutation API here: those are
 * later sub-phases. What exists is the smallest surface that exercises
 * authenticate → authorize → tenant transaction end to end over HTTP.
 */

/** The identity authorization consumes. Nothing else from the session is passed on. */
function identityOf(request: FastifyRequest): AuthenticatedIdentityRef | null {
  const identity = request.auth.identity;
  return identity === null ? null : { userId: identity.user.id };
}

export interface RegisterAuthorizationRoutesOptions {
  readonly service: AuthorizationService;
  readonly logger: Logger;
}

export function registerAuthorizationRoutes(
  app: FastifyInstance,
  options: RegisterAuthorizationRoutesOptions,
): void {
  const { service, logger } = options;

  /**
   * Translates a thrown authorization refusal into its response.
   *
   * Any other error propagates to the error handler, so a bug never degrades into an
   * accidental 403/404 that looks like a policy decision.
   */
  function handleFailure(
    request: FastifyRequest,
    reply: FastifyReply,
    error: unknown,
    context: Record<string, string>,
  ): FastifyReply {
    if (!isAuthorizationError(error)) {
      throw error;
    }

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

  app.get('/auth/organizations', async (request, reply) => {
    const identity = identityOf(request);

    if (identity === null) {
      authenticationRequired(request, reply);
      return reply;
    }

    const memberships = await service.listOrganizations(identity);

    // Explicit projection and re-validation of the two policy fields: a row whose
    // role or mode this build does not know is dropped rather than reported, so an
    // unrecognised value can never reach a client as if it were authorization.
    const organizations: OrganizationListResponse['organizations'] = [];

    for (const membership of memberships) {
      const role = organizationRoleSchema.safeParse(membership.role);
      const mode = clientAccessModeSchema.safeParse(membership.clientAccessMode);

      if (!role.success || !mode.success) {
        logger.error(
          { requestId: String(request.id), membershipId: membership.membershipId },
          'membership row carries an unrecognised role or client access mode',
        );
        continue;
      }

      organizations.push({
        organizationId: membership.organizationId,
        organizationName: membership.organizationName,
        organizationSlug: membership.organizationSlug,
        membershipId: membership.membershipId,
        role: role.data,
        clientAccessMode: mode.data,
      });
    }

    const body: OrganizationListResponse = { organizations };

    reply.header('cache-control', 'no-store').code(200).send(body);
    return reply;
  });

  app.get<{ Params: { organizationId: string } }>(
    '/organizations/:organizationId',
    async (request, reply) => {
      const identity = identityOf(request);

      if (identity === null) {
        authenticationRequired(request, reply);
        return reply;
      }

      // Routing input. It is never authorization: what follows verifies it against
      // the caller's persisted membership before any tenant context exists.
      const requestedOrganizationId = request.params.organizationId;

      try {
        const body = await service.withAuthorizedOrganization(
          identity,
          requestedOrganizationId,
          async (session: AuthorizedOrganizationSession): Promise<OrganizationResponse | null> => {
            session.require('organization.read');

            const organization = await session.repositories.organizations.getCurrent();

            if (organization === null) {
              return null;
            }

            return {
              id: organization.id,
              name: organization.name,
              slug: organization.slug,
              access: {
                membershipId: session.context.membershipId,
                role: session.context.role,
                clientAccessMode: session.context.clientAccessMode,
                permissions: [...permissionsForRole(session.context.role)],
              },
            };
          },
        );

        if (body === null) {
          resourceNotFound(request, reply);
          return reply;
        }

        reply.header('cache-control', 'no-store').code(200).send(body);
        return reply;
      } catch (error: unknown) {
        return handleFailure(request, reply, error, { userId: identity.userId });
      }
    },
  );
}
