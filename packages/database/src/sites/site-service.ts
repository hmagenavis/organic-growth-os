import { AuthorizationError, type AuthenticatedIdentityRef } from '@organic-os/authorization';
import { z } from 'zod';

import type { AdministrationRequest } from '../administration/membership-administration.js';
import type {
  AuthorizationService,
  AuthorizedOrganizationSession,
} from '../authorization/with-authorized-organization.js';
import type { SiteRecord, SiteWithSettings } from '../repositories/sites.js';
import type { JsonObject } from '../schema/columns.js';
import type { AutopilotMode, SiteStatus } from '../schema/enums.js';
import { normalizeBaseUrl, normalizeLanguage, normalizeTimezone } from './normalize.js';

/**
 * Sites: the second tenant business resource with an API (Phase 0.4.2B2).
 *
 * A site is not authorized on its own. It belongs to a client, and the rule sub-phase
 * 0.4.2B1 established for clients is the rule that reaches it:
 *
 *   **authorized = site permission AND parent-client access.**
 *
 * There is deliberately **no site-level scope system**. `membership_client_scopes` is
 * the only scope table, and a site is reachable exactly when its parent client is, so
 * every operation here begins with `session.requireClient(<site permission>,
 * clientId)` — which proves the role holds the permission, that the client belongs to
 * the authorized organization, and that the caller's client access covers it. A
 * `scoped` agency_admin therefore cannot read, create or update a site under a client
 * it was not scoped to, despite holding every `site.*` permission.
 *
 * Route parameters are routing input and nothing else. The organization comes from the
 * proven membership, the client id used against the database comes from the
 * `AuthorizedClientContext` that `requireClient` returned, and a site id is accepted
 * only after the row it names is shown to belong to *both*.
 *
 * ## The safe-initialization invariant
 *
 * Every site created through `createSite` gets its `site_settings` row in the same
 * transaction, with `autopilot_mode = 'review'`, and the caller cannot choose
 * otherwise: `CreateSiteRequest` has no autopilot field, the request contract rejects
 * unknown keys, and `siteSettings.createForSite` takes no mode parameter. A site that
 * could be created directly in `safe_autopilot` would be a site that never passed
 * through the review period the whole execution-safety model rests on
 * (docs/EXECUTION-SAFETY.md §3.1). Because the settings insert and the audit row share
 * the one transaction `withAuthorizedOrganization` opened, a site can never be
 * committed without them.
 *
 * Editing those settings is not part of this sub-phase, and the absence is deliberate:
 * autopilot graduation, risk overrides and execution preferences are safety policy
 * with their own approval and audit requirements, not CRUD.
 */

/**
 * One site, as the API reports it.
 *
 * `organizationId` and `clientId` are deliberately absent: both are already in the
 * request path, and a business object that carries tenant identifiers invites code
 * that reads them back as authorization.
 *
 * `autopilotMode` is the one piece of settings state reported here, because a client
 * of this API needs to know whether a site is still in review, and it is read-only.
 * Nothing else from `site_settings` is exposed — graduation policy, risk overrides,
 * model-router overrides, ingestion, crawl schedule and retention are internal
 * execution policy and stay internal until the phase that governs them exists.
 */
export interface SiteView {
  readonly id: string;
  readonly baseUrl: string;
  readonly cmsType: 'wordpress';
  readonly status: SiteStatus;
  readonly timezone: string;
  readonly language: string;
  /** `null` only if no settings row exists, which this service cannot produce. */
  readonly autopilotMode: AutopilotMode | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ListSitesQuery {
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface SiteListResult {
  readonly sites: readonly SiteView[];
  readonly limit: number;
  readonly nextCursor: string | null;
}

/**
 * Create a site.
 *
 * No `organizationId`, no `clientId`, no `autopilotMode`, no `status`, no `cmsType`,
 * no crawl budget and no integration field of any kind. The first two come from the
 * authorization context; the third is system policy (§ above); the rest belong to
 * phases that do not exist yet.
 */
export interface CreateSiteRequest {
  readonly baseUrl: string;
  readonly timezone?: string | undefined;
  readonly language?: string | undefined;
}

/**
 * The mutable half of a site, and nothing else.
 *
 * An explicit optional field per column rather than a partial record, so adding a
 * column to `sites` cannot silently make it patchable. There is no nullable field
 * here: every writable site column is `NOT NULL`, so a patch either sets a value or
 * omits the key.
 */
export interface UpdateSitePatch {
  readonly baseUrl?: string | undefined;
  readonly timezone?: string | undefined;
  readonly language?: string | undefined;
}

export interface SiteService {
  listSites(
    identity: AuthenticatedIdentityRef,
    organizationId: string,
    clientId: string,
    query: ListSitesQuery,
  ): Promise<SiteListResult>;

  getSite(
    identity: AuthenticatedIdentityRef,
    organizationId: string,
    clientId: string,
    siteId: string,
  ): Promise<SiteView>;

  createSite(
    identity: AuthenticatedIdentityRef,
    organizationId: string,
    clientId: string,
    input: CreateSiteRequest,
    request: AdministrationRequest,
  ): Promise<SiteView>;

  updateSite(
    identity: AuthenticatedIdentityRef,
    organizationId: string,
    clientId: string,
    siteId: string,
    patch: UpdateSitePatch,
    request: AdministrationRequest,
  ): Promise<SiteView>;
}

export interface SiteServiceOptions {
  readonly authorization: AuthorizationService;
}

const siteIdSchema = z.uuid();

/** A site this caller cannot reach reads as absent, never as forbidden. */
function siteNotReachable(): AuthorizationError {
  return new AuthorizationError('resource_not_in_organization', { resource: 'site' });
}

function toSiteView(row: SiteRecord, autopilotMode: AutopilotMode | null): SiteView {
  return {
    id: row.id,
    baseUrl: row.baseUrl,
    cmsType: row.cmsType,
    status: row.status,
    timezone: row.timezone,
    language: row.language,
    autopilotMode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function viewOf(found: SiteWithSettings): SiteView {
  return toSiteView(found.site, found.autopilotMode);
}

/**
 * The audit `before`/`after` payload.
 *
 * Every field is site configuration a member of the organization can already read.
 * There is nothing sensitive on `sites` to withhold: the table holds no credential, no
 * token and no integration setting, and WordPress application passwords, Google OAuth
 * tokens, session cookies and CSRF secrets are not reachable from this module at all.
 * The base URL is recorded in full, because a change of base URL is the single most
 * consequential edit this API allows — it repoints every future crawl, and a trail
 * that recorded only "the URL changed" could not answer what it changed from.
 */
function auditState(view: SiteView): JsonObject {
  return {
    baseUrl: view.baseUrl,
    cmsType: view.cmsType,
    status: view.status,
    timezone: view.timezone,
    language: view.language,
  };
}

/** Whether the patch would actually change the stored row. */
function isEffectiveChange(current: SiteRecord, patch: NormalizedSitePatch): boolean {
  if (patch.baseUrl !== undefined && patch.baseUrl !== current.baseUrl) {
    return true;
  }
  if (patch.timezone !== undefined && patch.timezone !== current.timezone) {
    return true;
  }
  if (patch.language !== undefined && patch.language !== current.language) {
    return true;
  }

  return false;
}

interface NormalizedSitePatch {
  readonly baseUrl?: string;
  readonly timezone?: string;
  readonly language?: string;
}

/**
 * Normalizes the writable fields before anything is compared or stored.
 *
 * Normalizing first is what makes `isEffectiveChange` honest — `https://a.test/` and
 * `https://a.test` are the same value, and a patch between them must not produce an
 * audit row claiming a change — and it is what makes
 * `UNIQUE (organization_id, base_url)` mean one site rather than one spelling.
 *
 * @throws {SiteInputError} for a value that cannot be normalized.
 */
function normalizePatch(patch: UpdateSitePatch): NormalizedSitePatch {
  return {
    ...(patch.baseUrl === undefined ? {} : { baseUrl: normalizeBaseUrl(patch.baseUrl) }),
    ...(patch.timezone === undefined ? {} : { timezone: normalizeTimezone(patch.timezone) }),
    ...(patch.language === undefined ? {} : { language: normalizeLanguage(patch.language) }),
  };
}

/**
 * Reads one site that must belong to the authorized client.
 *
 * The id is shape-checked first so a malformed one is refused as unreachable instead
 * of reaching PostgreSQL as a failed cast, and the repository predicate carries both
 * the organization and the parent client — so a real site of this organization paired
 * with the wrong client id in the URL is answered exactly like one that does not
 * exist.
 */
async function requireSite(
  session: AuthorizedOrganizationSession,
  clientId: string,
  siteId: string,
): Promise<SiteWithSettings> {
  if (!siteIdSchema.safeParse(siteId).success) {
    throw siteNotReachable();
  }

  const found = await session.repositories.sites.findByIdForClient(clientId, siteId);

  if (found === null) {
    throw siteNotReachable();
  }

  return found;
}

export function createSiteService(options: SiteServiceOptions): SiteService {
  const { authorization } = options;

  return {
    async listSites(identity, organizationId, clientId, query): Promise<SiteListResult> {
      return authorization.withAuthorizedOrganization(identity, organizationId, async (session) => {
        // Permission, organization ownership and client scope, before a single site
        // row is read. A caller that cannot reach the client learns nothing about how
        // many sites it has.
        const client = await session.requireClient('site.read', clientId);

        const page = await session.repositories.sites.listAuthorizedPage(client.clientId, {
          limit: query.limit,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        });

        return {
          sites: page.sites.map(viewOf),
          limit: query.limit,
          nextCursor: page.nextCursor,
        };
      });
    },

    async getSite(identity, organizationId, clientId, siteId): Promise<SiteView> {
      return authorization.withAuthorizedOrganization(identity, organizationId, async (session) => {
        const client = await session.requireClient('site.read', clientId);

        return viewOf(await requireSite(session, client.clientId, siteId));
      });
    },

    async createSite(identity, organizationId, clientId, input, request): Promise<SiteView> {
      return authorization.withAuthorizedOrganization(identity, organizationId, async (session) => {
        // `site.create` is agency_admin-only, and the parent client must still be in
        // reach: a scoped administrator cannot create a site under a client outside
        // its scope, because the role grants the verb and not the reach.
        const client = await session.requireClient('site.create', clientId);

        const baseUrl = normalizeBaseUrl(input.baseUrl);
        const timezone =
          input.timezone === undefined ? undefined : normalizeTimezone(input.timezone);
        const language =
          input.language === undefined ? undefined : normalizeLanguage(input.language);

        // `organization_id` is not an argument at all — the repository takes it from
        // the tenant context — and `client_id` comes from the authorized client
        // context rather than from the route or the body.
        const created = await session.repositories.sites.create({
          clientId: client.clientId,
          baseUrl,
          ...(timezone === undefined ? {} : { timezone }),
          ...(language === undefined ? {} : { language }),
        });

        // Same transaction. If this fails, the site is not committed either — which is
        // the point: a site without settings would be a site with no autopilot mode,
        // and every later execution decision reads that mode.
        const settings = await session.repositories.siteSettings.createForSite(created.id);

        if (settings.autopilotMode !== 'review') {
          // Unreachable through this code path; if it ever is reached, the safe answer
          // is to abort the transaction rather than to commit a site that starts in a
          // more permissive mode than policy allows.
          throw new Error('site settings were not initialized in review mode');
        }

        const view = toSiteView(created, settings.autopilotMode);

        await session.repositories.auditLogs.append({
          action: 'site.created',
          targetType: 'site',
          targetId: created.id,
          before: null,
          after: {
            ...auditState(view),
            // Recorded as ownership and as policy, not as caller input: neither value
            // could be supplied by the request.
            clientId: client.clientId,
            autopilotMode: settings.autopilotMode,
            autopilotModeSource: 'system_policy',
          },
          source: request.source,
          result: 'ok',
          ip: request.ip,
        });

        return view;
      });
    },

    async updateSite(
      identity,
      organizationId,
      clientId,
      siteId,
      patch,
      request,
    ): Promise<SiteView> {
      return authorization.withAuthorizedOrganization(identity, organizationId, async (session) => {
        const client = await session.requireClient('site.update', clientId);

        if (!siteIdSchema.safeParse(siteId).success) {
          throw siteNotReachable();
        }

        // Locked before it is read, so the audit `before` is the state the update is
        // actually applied to rather than a snapshot another transaction has since
        // moved on from. The lock predicate carries the parent client, so a site of
        // this organization under a different client locks nothing and reads as
        // absent.
        const locked = await session.repositories.sites.lockByIdForClient(client.clientId, siteId);

        if (locked === null) {
          throw siteNotReachable();
        }

        const normalized = normalizePatch(patch);

        if (!isEffectiveChange(locked, normalized)) {
          // Idempotent: nothing changed, so `updated_at` does not move and no audit
          // row is written. Recording a mutation that did not happen would make the
          // trail less trustworthy, not more.
          const unchanged = await session.repositories.siteSettings.findBySiteId(locked.id);
          return toSiteView(locked, unchanged?.autopilotMode ?? null);
        }

        const before = toSiteView(locked, null);

        const updated = await session.repositories.sites.updateForClient(
          client.clientId,
          siteId,
          normalized,
        );

        if (updated === null) {
          throw siteNotReachable();
        }

        const settings = await session.repositories.siteSettings.findBySiteId(updated.id);
        const after = toSiteView(updated, settings?.autopilotMode ?? null);

        await session.repositories.auditLogs.append({
          action: 'site.updated',
          targetType: 'site',
          targetId: siteId,
          before: auditState(before),
          after: auditState(after),
          source: request.source,
          result: 'ok',
          ip: request.ip,
        });

        return after;
      });
    },
  };
}
