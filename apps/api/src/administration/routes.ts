import {
  isAuthorizationError,
  isMembershipAdministrationError,
  type AuthenticatedIdentityRef,
} from '@organic-os/authorization';
import {
  createMemberRequestSchema,
  replaceMemberScopesRequestSchema,
  updateMemberRoleRequestSchema,
  type Member,
  type MemberListResponse,
  type MemberResponse,
} from '@organic-os/contracts';
import type {
  AdministrationRequest,
  ClientAccessRequest,
  MemberAdministrationService,
  MemberView,
} from '@organic-os/database';
import type { Logger } from '@organic-os/observability';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { authenticationRequired } from '../auth/problems.js';
import { sendAuthorizationFailure } from '../authorization/problems.js';
import { invalidAdministrationBody, sendMembershipAdministrationFailure } from './problems.js';

/**
 * Member administration over HTTP (Phase 0.4.2A).
 *
 * Five routes, all organization-scoped, all `agency_admin`-only:
 *
 *   GET    /organizations/:organizationId/members
 *   POST   /organizations/:organizationId/members
 *   PATCH  /organizations/:organizationId/members/:membershipId/role
 *   PUT    /organizations/:organizationId/members/:membershipId/scopes
 *   DELETE /organizations/:organizationId/members/:membershipId
 *
 * These handlers hold no policy and no SQL. Each one authenticates, parses its body
 * against the contract, and hands the request to `MemberAdministrationService`, which
 * runs the whole authenticate → authorize → lock → mutate → revoke → audit pipeline
 * inside one transaction. A handler cannot skip a step because there is no step here
 * to skip: there is no way to reach a repository from this file, and nothing here
 * sets a tenant context.
 *
 * Both path parameters are routing input. The organization id is verified against the
 * caller's persisted membership before anything else happens; the membership id is
 * verified against the *authorized* organization inside the transaction, so a
 * membership id belonging to another tenant reads as absent.
 *
 * CSRF is already enforced for every state-changing method by the authentication
 * plugin, so `POST`, `PATCH`, `PUT` and `DELETE` here are covered without restating
 * anything (`auth/plugin.ts`).
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
function administrationRequest(request: FastifyRequest): AdministrationRequest {
  return { source: 'api', ip: request.ip };
}

/** Explicit projection: `MemberView` is already safe, and this keeps it that way. */
function toMember(view: MemberView): Member {
  return {
    membershipId: view.membershipId,
    userId: view.userId,
    email: view.email,
    name: view.name,
    role: view.role,
    clientAccessMode: view.clientAccessMode,
    scopedClientIds: [...view.scopedClientIds],
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
  };
}

export interface RegisterAdministrationRoutesOptions {
  readonly members: MemberAdministrationService;
  readonly logger: Logger;
}

export function registerAdministrationRoutes(
  app: FastifyInstance,
  options: RegisterAdministrationRoutesOptions,
): void {
  const { members, logger } = options;

  /**
   * Translates a refusal into its response.
   *
   * Two vocabularies, deliberately kept apart: an `AuthorizationError` is answered by
   * the non-enumerating mapping from sub-phase 0.4.1, and a
   * `MembershipAdministrationError` by the explicit one next door. Anything else is
   * re-thrown, so a bug can never degrade into a response that looks like a policy
   * decision.
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

    if (isMembershipAdministrationError(error)) {
      // Logged rather than audited. The transaction that would have carried an audit
      // row is the transaction being rolled back, and a "denied" row written from a
      // second transaction would be a claim about a mutation that never happened
      // (docs/phases/PHASE-0.4.1-IMPLEMENTATION.md §9).
      logger.warn(
        {
          requestId: String(request.id),
          method: request.method,
          url: request.url,
          failure: error.failure,
          ...context,
        },
        'member administration refused',
      );

      sendMembershipAdministrationFailure(request, reply, error.failure);
      return reply;
    }

    throw error;
  }

  app.get<{ Params: { organizationId: string } }>(
    '/organizations/:organizationId/members',
    async (request, reply) => {
      const identity = identityOf(request);

      if (identity === null) {
        authenticationRequired(request, reply);
        return reply;
      }

      try {
        const listed = await members.listMembers(identity, request.params.organizationId);
        const body: MemberListResponse = { members: listed.map(toMember) };

        reply.header('cache-control', 'no-store').code(200).send(body);
        return reply;
      } catch (error: unknown) {
        return handleFailure(request, reply, error, { userId: identity.userId });
      }
    },
  );

  app.post<{ Params: { organizationId: string } }>(
    '/organizations/:organizationId/members',
    async (request, reply) => {
      const identity = identityOf(request);

      if (identity === null) {
        authenticationRequired(request, reply);
        return reply;
      }

      const parsed = createMemberRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        invalidAdministrationBody(request, reply);
        return reply;
      }

      try {
        const created = await members.addMember(
          identity,
          request.params.organizationId,
          {
            email: parsed.data.email,
            role: parsed.data.role,
            clientAccess: parsed.data.clientAccess satisfies ClientAccessRequest,
          },
          administrationRequest(request),
        );

        const body: MemberResponse = { member: toMember(created) };

        reply.header('cache-control', 'no-store').code(201).send(body);
        return reply;
      } catch (error: unknown) {
        return handleFailure(request, reply, error, { userId: identity.userId });
      }
    },
  );

  app.patch<{ Params: { organizationId: string; membershipId: string } }>(
    '/organizations/:organizationId/members/:membershipId/role',
    async (request, reply) => {
      const identity = identityOf(request);

      if (identity === null) {
        authenticationRequired(request, reply);
        return reply;
      }

      const parsed = updateMemberRoleRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        invalidAdministrationBody(request, reply);
        return reply;
      }

      try {
        const updated = await members.changeMemberRole(
          identity,
          request.params.organizationId,
          { membershipId: request.params.membershipId, role: parsed.data.role },
          administrationRequest(request),
        );

        const body: MemberResponse = { member: toMember(updated) };

        reply.header('cache-control', 'no-store').code(200).send(body);
        return reply;
      } catch (error: unknown) {
        return handleFailure(request, reply, error, { userId: identity.userId });
      }
    },
  );

  app.put<{ Params: { organizationId: string; membershipId: string } }>(
    '/organizations/:organizationId/members/:membershipId/scopes',
    async (request, reply) => {
      const identity = identityOf(request);

      if (identity === null) {
        authenticationRequired(request, reply);
        return reply;
      }

      const parsed = replaceMemberScopesRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        invalidAdministrationBody(request, reply);
        return reply;
      }

      try {
        const updated = await members.replaceMemberScopes(
          identity,
          request.params.organizationId,
          {
            membershipId: request.params.membershipId,
            clientAccess: parsed.data satisfies ClientAccessRequest,
          },
          administrationRequest(request),
        );

        const body: MemberResponse = { member: toMember(updated) };

        reply.header('cache-control', 'no-store').code(200).send(body);
        return reply;
      } catch (error: unknown) {
        return handleFailure(request, reply, error, { userId: identity.userId });
      }
    },
  );

  app.delete<{ Params: { organizationId: string; membershipId: string } }>(
    '/organizations/:organizationId/members/:membershipId',
    async (request, reply) => {
      const identity = identityOf(request);

      if (identity === null) {
        authenticationRequired(request, reply);
        return reply;
      }

      try {
        await members.removeMember(
          identity,
          request.params.organizationId,
          { membershipId: request.params.membershipId },
          administrationRequest(request),
        );

        reply.header('cache-control', 'no-store').code(204).send();
        return reply;
      } catch (error: unknown) {
        return handleFailure(request, reply, error, { userId: identity.userId });
      }
    },
  );
}
