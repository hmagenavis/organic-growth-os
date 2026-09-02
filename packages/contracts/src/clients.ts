import { z } from 'zod';

/**
 * Client contracts (Phase 0.4.2B1).
 *
 * The first tenant *business* resource to reach the API. Everything here follows the
 * rule the authorization contracts state: a request never carries authorization. A
 * client body has no `organizationId` and no membership data, because the
 * organization comes from the proven membership behind the URL and the caller's
 * client access comes from its own membership row (docs/SECURITY.md §3).
 *
 * Field bounds mirror the database. `clients.name` is `CHECK (length(btrim(name))
 * BETWEEN 1 AND 200)` in migration 0001, so `name` is trimmed and bounded here and a
 * blank or oversized name is a 400 rather than a constraint violation surfacing as a
 * 500. `industry` and `notes` carry no database bound; the limits below are an API
 * decision that keeps a request body finite, not an invented schema rule.
 */

/**
 * A client, as the API reports it.
 *
 * Deliberately selected rather than a serialized row. `organizationId` is absent: it
 * is already in the request path, it is never client-supplied, and echoing a tenant
 * identifier into every business object invites code that reads it back as
 * authorization (§15 of the sub-phase brief).
 *
 * `status` is reported but not writable in this sub-phase — the archive lifecycle is
 * deferred together with deletion.
 */
export const clientSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  status: z.enum(['active', 'archived']),
  industry: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Client = z.infer<typeof clientSchema>;

/** Default page size when the caller does not ask for one. */
export const CLIENT_PAGE_DEFAULT_LIMIT = 50;
/** Largest page a caller may ask for. Asking for more is a 400, never a silent clamp. */
export const CLIENT_PAGE_MAX_LIMIT = 100;

/**
 * List query parameters.
 *
 * Keyset pagination, not offset: the cursor names the last row the caller was given,
 * so a page cannot silently repeat or skip a client when another administrator
 * inserts one mid-traversal. `strictObject` because an unrecognised parameter is
 * almost always a caller bug — a mistyped `limit` that is ignored looks like the
 * server refusing to page.
 *
 * Over-limit is rejected rather than clamped. A caller that asked for 1000 and
 * received 100 has no way to tell that from an organization with 100 clients.
 */
export const clientListQuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CLIENT_PAGE_MAX_LIMIT)
    .default(CLIENT_PAGE_DEFAULT_LIMIT),
  /** Opaque. Produced by the server; a caller must not construct one. */
  cursor: z.string().min(1).max(512).optional(),
});

export type ClientListQuery = z.infer<typeof clientListQuerySchema>;

/**
 * One page of clients.
 *
 * There is deliberately no total count. A count is either restricted to the rows the
 * caller may reach — in which case it is an extra query for a number nobody needs
 * yet — or it is the organization's total, which would tell a `scoped` membership
 * exactly how many clients exist outside its scope (§24 of the sub-phase brief).
 */
export const clientPageSchema = z.object({
  limit: z.number().int().min(1).max(CLIENT_PAGE_MAX_LIMIT),
  /** `null` on the last page. Pass it back as `?cursor=` to continue. */
  nextCursor: z.string().min(1).nullable(),
});

export const clientListResponseSchema = z.object({
  clients: z.array(clientSchema),
  page: clientPageSchema,
});

export type ClientListResponse = z.infer<typeof clientListResponseSchema>;

export const clientResponseSchema = z.object({
  client: clientSchema,
});

export type ClientResponse = z.infer<typeof clientResponseSchema>;

/** Bounds that keep a request body finite. Neither field is constrained by the schema. */
const INDUSTRY_MAX_LENGTH = 120;
const NOTES_MAX_LENGTH = 4000;

const clientNameSchema = z.string().trim().min(1).max(200);
const industrySchema = z.string().trim().max(INDUSTRY_MAX_LENGTH);
const notesSchema = z.string().trim().max(NOTES_MAX_LENGTH);

/**
 * Create a client.
 *
 * No `organizationId`: it comes from the authorized organization context, and a body
 * that carried one would be a field the server must remember to ignore. `strictObject`
 * makes sending one a 400 instead.
 *
 * No `status` either. `archived` is the archive half of a lifecycle this sub-phase
 * defers along with deletion, so a client is created `active` and stays that way
 * until that lifecycle is designed (§3 of the sub-phase brief).
 */
export const createClientRequestSchema = z.strictObject({
  name: clientNameSchema,
  industry: industrySchema.nullable().optional(),
  notes: notesSchema.nullable().optional(),
});

export type CreateClientRequestBody = z.infer<typeof createClientRequestSchema>;

/**
 * Update a client.
 *
 * A patch of explicitly enumerated fields — never an object spread into an UPDATE.
 * `id`, `organizationId`, `createdAt`, `updatedAt` and `status` are all rejected by
 * `strictObject`: the first four are identity and tenancy, and `status` belongs to
 * the deferred archive lifecycle.
 *
 * `null` clears `industry` or `notes`; omitting a field leaves it alone. An empty
 * patch is refused rather than treated as a no-op, because a caller that sent
 * `{}` did not mean to change nothing — it usually means the field name was wrong.
 */
export const updateClientRequestSchema = z
  .strictObject({
    name: clientNameSchema.optional(),
    industry: industrySchema.nullable().optional(),
    notes: notesSchema.nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'at least one field must be present',
  });

export type UpdateClientRequestBody = z.infer<typeof updateClientRequestSchema>;
