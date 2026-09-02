import { z } from 'zod';

/**
 * Site contracts (Phase 0.4.2B2).
 *
 * Sites are nested under their client, and the nesting is routing rather than
 * authorization: the organization comes from the caller's proven membership, the
 * parent client is authorized against that membership's client access, and a site is
 * reached only after it is shown to belong to both. Nothing in a request body carries
 * tenancy, so there is no `organizationId`, no `clientId` and no `siteId` field here.
 *
 * ## What a site body may contain
 *
 * `sites` (migration 0001) has exactly three columns this sub-phase treats as
 * writable: `base_url`, `timezone` and `language`. Everything else on the table is
 * either identity (`id`, `organization_id`, `client_id`, `created_at`, `updated_at`),
 * fixed (`cms_type`, whose only allowed value is `wordpress`), part of a deferred
 * lifecycle (`status`), or configuration belonging to a later phase (`crawl_budget`).
 * No WordPress credential, Search Console property, Analytics id, tag-manager
 * configuration, API key or model setting appears here, and none has a column to
 * appear in.
 *
 * ## Where the values are decided
 *
 * These schemas check **shape** — present, non-empty, bounded, no whitespace tricks.
 * The **value** is decided by `@organic-os/database`, which normalizes a base URL, a
 * time zone and a language tag before storing them. That split is deliberate: the
 * stored form has to be identical whether a site arrives over HTTP or from a future
 * importer, and `sites` carries `UNIQUE (organization_id, base_url)`, which only means
 * "one site" if every writer agrees on what one URL is. Duplicating the rule here
 * would create a second place for it to drift.
 */

export const SITE_STATUSES = ['active', 'paused', 'archived'] as const;
export const AUTOPILOT_MODES = ['off', 'review', 'safe_autopilot', 'full_autopilot'] as const;

/**
 * A site, as the API reports it.
 *
 * Deliberately selected rather than a serialized row. `organizationId` and `clientId`
 * are absent — both are already in the request path, and echoing tenant identifiers
 * into every business object invites code that reads them back as authorization.
 *
 * `autopilotMode` is the only settings state reported, and it is read-only: a caller
 * needs to know whether a site is still in review, but graduation policy, risk
 * overrides, model-router settings, ingestion caps, crawl schedule and retention are
 * internal execution policy and are not exposed by this API at all. It is nullable
 * because a settings row is what makes it meaningful; every site created through this
 * API has one.
 *
 * `status` is reported but not writable in this sub-phase — the archive lifecycle is
 * deferred along with deletion, exactly as it is for clients.
 */
export const siteSchema = z.object({
  id: z.uuid(),
  baseUrl: z.string().min(1),
  cmsType: z.literal('wordpress'),
  status: z.enum(SITE_STATUSES),
  timezone: z.string().min(1),
  language: z.string().min(1),
  autopilotMode: z.enum(AUTOPILOT_MODES).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Site = z.infer<typeof siteSchema>;

/** Default page size when the caller does not ask for one. */
export const SITE_PAGE_DEFAULT_LIMIT = 50;
/** Largest page a caller may ask for. Asking for more is a 400, never a silent clamp. */
export const SITE_PAGE_MAX_LIMIT = 100;

/**
 * List query parameters. The same keyset contract the client collection uses.
 *
 * Keyset pagination, not offset: the cursor names the last row the caller was given,
 * so a page cannot silently repeat or skip a site when another administrator inserts
 * one mid-traversal. `strictObject` because an unrecognised parameter is almost always
 * a caller bug. Over-limit is rejected rather than clamped, so a caller that asked for
 * 1000 and received 100 cannot mistake that for a client that has exactly 100 sites.
 */
export const siteListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(SITE_PAGE_MAX_LIMIT).default(SITE_PAGE_DEFAULT_LIMIT),
  /** Opaque. Produced by the server; a caller must not construct one. */
  cursor: z.string().min(1).max(512).optional(),
});

export type SiteListQuery = z.infer<typeof siteListQuerySchema>;

/**
 * One page of sites.
 *
 * No total count, for the same reason the client collection has none: the only honest
 * count is "rows this caller may reach", and anything wider would describe data
 * outside the caller's scope.
 */
export const sitePageSchema = z.object({
  limit: z.number().int().min(1).max(SITE_PAGE_MAX_LIMIT),
  /** `null` on the last page. Pass it back as `?cursor=` to continue. */
  nextCursor: z.string().min(1).nullable(),
});

export const siteListResponseSchema = z.object({
  sites: z.array(siteSchema),
  page: sitePageSchema,
});

export type SiteListResponse = z.infer<typeof siteListResponseSchema>;

export const siteResponseSchema = z.object({
  site: siteSchema,
});

export type SiteResponse = z.infer<typeof siteResponseSchema>;

/**
 * Bounds that keep a request body finite and match what the database stores.
 *
 * They are duplicated from `@organic-os/database` as numbers rather than imported,
 * because the contracts package deliberately depends on nothing but Zod; a mismatch
 * would cost a 400 that could have been a 400 one layer later, never a stored value
 * the database rejects.
 */
const BASE_URL_MAX_LENGTH = 2048;
const TIMEZONE_MAX_LENGTH = 64;
const LANGUAGE_MAX_LENGTH = 35;

/** No internal whitespace: the `base_url` CHECK in migration 0001 forbids it outright. */
const baseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(BASE_URL_MAX_LENGTH)
  .refine((value) => !/\s/.test(value), { message: 'must not contain whitespace' });

const timezoneSchema = z.string().trim().min(1).max(TIMEZONE_MAX_LENGTH);
const languageSchema = z.string().trim().min(1).max(LANGUAGE_MAX_LENGTH);

/**
 * Create a site.
 *
 * `strictObject`, so a body carrying `organizationId`, `clientId`, `autopilotMode`,
 * `status`, `cmsType`, `crawlBudget` or any integration field is a 400 rather than a
 * field the server must remember to ignore.
 *
 * **`autopilotMode` is not accepted, and this is a safety property rather than a
 * validation preference.** A new site is initialized in `review` by system policy; a
 * caller that could name a mode could create a site that begins in `safe_autopilot`
 * and never passes through review (docs/EXECUTION-SAFETY.md §3.1).
 */
export const createSiteRequestSchema = z.strictObject({
  baseUrl: baseUrlSchema,
  timezone: timezoneSchema.optional(),
  language: languageSchema.optional(),
});

export type CreateSiteRequestBody = z.infer<typeof createSiteRequestSchema>;

/**
 * Update a site.
 *
 * A patch of explicitly enumerated fields — never an object spread into an UPDATE.
 * Rejected by `strictObject`: `id`, `organizationId`, `clientId`, `createdAt`,
 * `updatedAt` (identity and tenancy), `cmsType` (fixed), `status` (deferred archive
 * lifecycle), `crawlBudget` (a later phase), `autopilotMode` and any other
 * settings field (not editable in this sub-phase, by design), and every unknown key.
 *
 * A site cannot be moved between clients: there is no `clientId` here, and the parent
 * client is part of the row predicate the update runs against.
 *
 * An empty patch is refused rather than treated as a no-op, because a caller that sent
 * `{}` did not mean to change nothing — it usually means the field name was wrong.
 */
export const updateSiteRequestSchema = z
  .strictObject({
    baseUrl: baseUrlSchema.optional(),
    timezone: timezoneSchema.optional(),
    language: languageSchema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'at least one field must be present',
  });

export type UpdateSiteRequestBody = z.infer<typeof updateSiteRequestSchema>;
