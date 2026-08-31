import { z } from 'zod';

/**
 * Authentication contracts (Phase 0.3).
 *
 * Identity only. There is deliberately no organization, role, membership or client
 * scope in any shape here — what an authenticated user may *do* is sub-phase 0.4's
 * contract surface, and putting a placeholder for it here would invite callers to
 * depend on authentication as if it were authorization (docs/SECURITY.md §3).
 */

/**
 * Login input.
 *
 * The password bound is generous on purpose: the login endpoint must not reveal the
 * password policy, so it accepts anything the hasher will accept and answers with the
 * same generic failure either way. The policy applies where a password is *set*.
 */
export const loginRequestSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(1024),
});

export type LoginRequestBody = z.infer<typeof loginRequestSchema>;

/** Identity-level view of the signed-in user. Never includes authorization data. */
export const currentUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string().min(1),
  locale: z.string().min(1),
});

export type CurrentUser = z.infer<typeof currentUserSchema>;

/**
 * Login response.
 *
 * The freshly issued CSRF token is returned in the body as well as in its cookie so a
 * client can immediately make a state-changing request without a second round trip.
 * It is a public nonce plus a MAC — it carries no secret and identifies nothing.
 */
export const loginResponseSchema = z.object({
  user: currentUserSchema,
  csrfToken: z.string().min(1),
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const csrfTokenResponseSchema = z.object({
  csrfToken: z.string().min(1),
  /** Header the token must be echoed in. Stated so clients do not hardcode it. */
  headerName: z.string().min(1),
});

export type CsrfTokenResponse = z.infer<typeof csrfTokenResponseSchema>;
