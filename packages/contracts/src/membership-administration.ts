import { z } from 'zod';

import { clientAccessModeSchema, organizationRoleSchema } from './authorization.js';

/**
 * Membership administration contracts (Phase 0.4.2A).
 *
 * `authorization.ts` states that no request shape there carries a role or a client
 * access mode, because a caller never states its *own* authorization. These schemas
 * are the deliberate exception and the reason they live in a separate file: an
 * agency admin states the authorization of *another* member. The distinction is
 * load-bearing —
 *
 *   * the acting caller's role and client access mode still come only from its own
 *     persisted membership row, re-read on every request;
 *   * the values below are applied to a *target* membership that the server proves
 *     belongs to the authorized organization before writing anything;
 *   * `agency_admin` is the only role that may send any of them.
 *
 * The role vocabulary is `organizationRoleSchema`, which contains organization roles
 * only. Platform administration is not in it, so a request naming `super_admin` or
 * `platform_admin` fails validation rather than reaching authorization logic
 * (docs/SECURITY.md §3).
 */

/**
 * What a member may reach at client level, stated explicitly (ADR-0016).
 *
 * A discriminated union rather than an optional array, because the two modes take
 * different data and the pair `{ mode: 'all_clients', clientIds: [...] }` has no
 * coherent meaning. Both branches are strict, so that pair is a 400 rather than a
 * silently ignored field: an administrator who sent a client list must never be left
 * believing it was applied.
 *
 * `{ mode: 'scoped', clientIds: [] }` is legal and means exactly zero clients.
 */
export const clientAccessSelectionSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('all_clients') }),
  z.strictObject({
    mode: z.literal('scoped'),
    clientIds: z
      .array(z.uuid())
      // Bounded so one request cannot ask for an unbounded number of lookups.
      .max(500)
      // Duplicates are rejected rather than collapsed: silently deduplicating a
      // request means the stored result does not match what was sent, and a scope
      // list is authorization data.
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'clientIds must not contain duplicates',
      }),
  }),
]);

export type ClientAccessSelection = z.infer<typeof clientAccessSelectionSchema>;

/**
 * One member of an organization, as an administrator sees them.
 *
 * Deliberately selected fields. `password_hash`, session data and
 * `is_platform_admin` are on the underlying rows and appear in no projection here:
 * platform administration is not organization data and an agency admin has no
 * business learning it (docs/SECURITY.md §3).
 *
 * `email` is included because member administration without an addressable identity
 * is unusable — an administrator who may add, re-role and remove a member may
 * already see who that member is.
 */
export const memberSchema = z.object({
  membershipId: z.uuid(),
  userId: z.uuid(),
  email: z.email(),
  name: z.string().min(1),
  role: organizationRoleSchema,
  clientAccessMode: clientAccessModeSchema,
  /** Empty for `all_clients`: scope rows are not authorization in that mode. */
  scopedClientIds: z.array(z.uuid()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Member = z.infer<typeof memberSchema>;

export const memberListResponseSchema = z.object({
  members: z.array(memberSchema),
});

export type MemberListResponse = z.infer<typeof memberListResponseSchema>;

export const memberResponseSchema = z.object({
  member: memberSchema,
});

export type MemberResponse = z.infer<typeof memberResponseSchema>;

/**
 * Attach an existing platform user to this organization.
 *
 * There is no password field and there never will be one on this endpoint: creating
 * a credential is a privileged operation the API process cannot perform at all
 * (docs/SECURITY.md §5). An address with no account yet is answered with
 * `INVITATION_FLOW_NOT_IMPLEMENTED` rather than a placeholder account.
 */
export const createMemberRequestSchema = z.strictObject({
  email: z.email().max(320),
  role: organizationRoleSchema,
  clientAccess: clientAccessSelectionSchema,
});

export type CreateMemberRequestBody = z.infer<typeof createMemberRequestSchema>;

export const updateMemberRoleRequestSchema = z.strictObject({
  role: organizationRoleSchema,
});

export type UpdateMemberRoleRequestBody = z.infer<typeof updateMemberRoleRequestSchema>;

/**
 * Full replacement of a membership's client access. Not a patch: the request states
 * the complete resulting access, so nothing is inherited from what was there before
 * and there is no shape that means "leave the rest alone".
 */
export const replaceMemberScopesRequestSchema = clientAccessSelectionSchema;

export type ReplaceMemberScopesRequestBody = z.infer<typeof replaceMemberScopesRequestSchema>;
