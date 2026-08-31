import { z } from 'zod';

/**
 * Authorization contracts (Phase 0.4.1).
 *
 * Kept separate from `auth.ts` on purpose: authentication contracts describe who the
 * caller is, these describe where the caller may act. Nothing in `auth.ts` references
 * an organization, so no client can mistake a session for tenant authority
 * (docs/SECURITY.md §3).
 *
 * Everything here is a *response* shape. There is no request shape carrying a role or
 * a client access mode, because a caller never states its own authorization — those
 * values come from persisted membership rows and are never read from a request.
 */

export const organizationRoleSchema = z.enum([
  'agency_admin',
  'seo_manager',
  'content_editor',
  'analyst',
  'client_viewer',
]);

export const clientAccessModeSchema = z.enum(['all_clients', 'scoped']);

/**
 * One organization the caller may choose to act in.
 *
 * `role` and `clientAccessMode` are reported so a UI can render what the caller can
 * do without guessing. They are informational: the server re-derives both from the
 * membership row on every subsequent request and never trusts them coming back in.
 */
export const organizationMembershipSchema = z.object({
  organizationId: z.uuid(),
  organizationName: z.string().min(1),
  organizationSlug: z.string().min(1),
  membershipId: z.uuid(),
  role: organizationRoleSchema,
  clientAccessMode: clientAccessModeSchema,
});

export type OrganizationMembership = z.infer<typeof organizationMembershipSchema>;

/** The organizations the caller belongs to. Empty is a valid, expected answer. */
export const organizationListResponseSchema = z.object({
  organizations: z.array(organizationMembershipSchema),
});

export type OrganizationListResponse = z.infer<typeof organizationListResponseSchema>;

/** An organization read under a proven membership, with the caller's own access. */
export const organizationResponseSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  access: z.object({
    membershipId: z.uuid(),
    role: organizationRoleSchema,
    clientAccessMode: clientAccessModeSchema,
    permissions: z.array(z.string().min(1)),
  }),
});

export type OrganizationResponse = z.infer<typeof organizationResponseSchema>;
