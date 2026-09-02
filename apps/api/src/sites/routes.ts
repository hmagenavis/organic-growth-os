import { isAuthorizationError, type AuthenticatedIdentityRef } from '@organic-os/authorization';
import {
  createSiteRequestSchema,
  siteListQuerySchema,
  updateSiteRequestSchema,
  type Site,
  type SiteListResponse,
  type SiteResponse,
} from '@organic-os/contracts';
import {
  isInvalidSiteCursorError,
  isSiteBaseUrlConflictError,
  isSiteInputError,
  type AdministrationRequest,
  type SiteService,
  type SiteView,
} from '@organic-os/database';
import type { Logger } from '@organic-os/observability';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { authenticationRequired } from '../auth/problems.js';
import { sendAuthorizationFailure } from '../authorization/problems.js';
import { invalidSiteBody, invalidSiteQuery, siteBaseUrlConflict } from './problems.js';

/**
 * The site API (Phase 0.4.2B2).
 *
 * Four routes, all nested under the parent client:
 *
 *   GET    /organizations/:organizationId/clients/:clientId/sites
 *   GET    /organizations/:organizationId/clients/:clientId/sites/:siteId
 *   POST   /organizations/:organizationId/clients/:clientId/sites
 *   PATCH  /organizations/:organizationId/clients/:clientId/sites/:siteId
 *
 * There is deliberately no `DELETE`, no archive/restore, and no site-settings route.
 * The first two are the lifecycle deferred with client deletion; the third is
 * execution-safety policy — autopilot graduation, risk overrides and execution
 * preferences — which is not CRUD and does not belong to a resource sub-phase.
 *
 * All three path parameters are routing input and nothing more. The organization is
 * verified against the caller's persisted membership; the client is verified inside
 * the authorized transaction against organization ownership *and* the membership's
 * client access; the site is verified against both the organization and that same
 * parent client. Nesting proves nothing on its own, which is why a valid site id
 * paired with the wrong client id in the URL answers exactly like a site that does not
 * exist.
 *
 * As in the client API, these handlers hold no policy and no SQL: nothing here can
 * reach a repository, open a transaction, set a tenant context or observe the caller's
 * role. CSRF is enforced for `POST` and `PATCH` by the authentication plugin.
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
function siteRequest(request: FastifyRequest): AdministrationRequest {
  return { source: 'api', ip: request.ip };
}

/** Explicit projection: `SiteView` is already selected, and this keeps it that way. */
function toSite(view: SiteView): Site {
  return {
    id: view.id,
    baseUrl: view.baseUrl,
    cmsType: view.cmsType,
    status: view.status,
    timezone: view.timezone,
    language: view.language,
    autopilotMode: view.autopilotMode,
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
  };
}

interface CollectionParams {
  organizationId: string;
  clientId: string;
}

interface ResourceParams extends CollectionParams {
  siteId: string;
}

export interface RegisterSiteRoutesOptions {
  readonly sites: SiteService;
  readonly logger: Logger;
}

export function registerSiteRoutes(app: FastifyInstance, options: RegisterSiteRoutesOptions): void {
  const { sites, logger } = options;

  /**
   * Translates a refusal into its response.
   *
   * An `AuthorizationError` is answered by the non-enumerating mapping from sub-phase
   * 0.4.1 — 403 only about the caller's own role, 404 for everything it cannot reach.
   * A bad cursor and an unnormalizable field value are request errors and are answered
   * as such, but only ever *after* authorization has succeeded, so neither can be used
   * to probe. A base-URL conflict is a 409. Anything else is re-thrown, so a bug cannot
   * degrade into a response that looks like a policy decision.
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

    if (isInvalidSiteCursorError(error)) {
      invalidSiteQuery(request, reply);
      return reply;
    }

    if (isSiteInputError(error)) {
      // The field and the reason are logged; neither reaches the response body, and
      // the rejected value reaches neither.
      logger.warn(
        {
          requestId: String(request.id),
          method: request.method,
          url: request.url,
          field: error.field,
          reason: error.reason,
          ...context,
        },
        'site input rejected',
      );

      invalidSiteBody(request, reply);
      return reply;
    }

    if (isSiteBaseUrlConflictError(error)) {
      siteBaseUrlConflict(request, reply);
      return reply;
    }

    throw error;
  }

  app.get<{ Params: CollectionParams }>(
    '/organizations/:organizationId/clients/:clientId/sites',
    async (request, reply) => {
      const identity = identityOf(request);

      if (identity === null) {
        authenticationRequired(request, reply);
        return reply;
      }

      const parsed = siteListQuerySchema.safeParse(request.query);

      if (!parsed.success) {
        invalidSiteQuery(request, reply);
        return reply;
      }

      try {
        const page = await sites.listSites(
          identity,
          request.params.organizationId,
          request.params.clientId,
          {
            limit: parsed.data.limit,
            ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
          },
        );

        const body: SiteListResponse = {
          sites: page.sites.map(toSite),
          // No total count, deliberately: the only honest one is "rows this caller may
          // reach".
          page: { limit: page.limit, nextCursor: page.nextCursor },
        };

        reply.header('cache-control', 'no-store').code(200).send(body);
        return reply;
      } catch (error: unknown) {
        return handleFailure(request, reply, error, { userId: identity.userId });
      }
    },
  );

  app.get<{ Params: ResourceParams }>(
    '/organizations/:organizationId/clients/:clientId/sites/:siteId',
    async (request, reply) => {
      const identity = identityOf(request);

      if (identity === null) {
        authenticationRequired(request, reply);
        return reply;
      }

      try {
        const site = await sites.getSite(
          identity,
          request.params.organizationId,
          request.params.clientId,
          request.params.siteId,
        );

        const body: SiteResponse = { site: toSite(site) };

        reply.header('cache-control', 'no-store').code(200).send(body);
        return reply;
      } catch (error: unknown) {
        return handleFailure(request, reply, error, { userId: identity.userId });
      }
    },
  );

  app.post<{ Params: CollectionParams }>(
    '/organizations/:organizationId/clients/:clientId/sites',
    async (request, reply) => {
      const identity = identityOf(request);

      if (identity === null) {
        authenticationRequired(request, reply);
        return reply;
      }

      const parsed = createSiteRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        invalidSiteBody(request, reply);
        return reply;
      }

      try {
        // Neither the organization nor the client is forwarded from the body: the
        // contract rejects them as unknown fields, and the service takes both from the
        // authorization context regardless.
        const created = await sites.createSite(
          identity,
          request.params.organizationId,
          request.params.clientId,
          {
            baseUrl: parsed.data.baseUrl,
            ...(parsed.data.timezone === undefined ? {} : { timezone: parsed.data.timezone }),
            ...(parsed.data.language === undefined ? {} : { language: parsed.data.language }),
          },
          siteRequest(request),
        );

        const body: SiteResponse = { site: toSite(created) };

        reply.header('cache-control', 'no-store').code(201).send(body);
        return reply;
      } catch (error: unknown) {
        return handleFailure(request, reply, error, { userId: identity.userId });
      }
    },
  );

  app.patch<{ Params: ResourceParams }>(
    '/organizations/:organizationId/clients/:clientId/sites/:siteId',
    async (request, reply) => {
      const identity = identityOf(request);

      if (identity === null) {
        authenticationRequired(request, reply);
        return reply;
      }

      const parsed = updateSiteRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        invalidSiteBody(request, reply);
        return reply;
      }

      try {
        const updated = await sites.updateSite(
          identity,
          request.params.organizationId,
          request.params.clientId,
          request.params.siteId,
          {
            ...(parsed.data.baseUrl === undefined ? {} : { baseUrl: parsed.data.baseUrl }),
            ...(parsed.data.timezone === undefined ? {} : { timezone: parsed.data.timezone }),
            ...(parsed.data.language === undefined ? {} : { language: parsed.data.language }),
          },
          siteRequest(request),
        );

        const body: SiteResponse = { site: toSite(updated) };

        reply.header('cache-control', 'no-store').code(200).send(body);
        return reply;
      } catch (error: unknown) {
        return handleFailure(request, reply, error, { userId: identity.userId });
      }
    },
  );
}
