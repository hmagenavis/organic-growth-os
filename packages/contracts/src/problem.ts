import { z } from 'zod';

/** Media type for RFC 9457 problem details responses. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Namespace for stable, documented problem type identifiers. */
export const PROBLEM_TYPE_BASE_URL = 'https://errors.organic-os.dev/';

/**
 * RFC 9457 problem details — the single error shape for every API response.
 *
 * `detail` is safe-to-expose text only. Stack traces, SQL, provider payloads and
 * any other internal diagnostic stay in the server logs (docs/SECURITY.md §8).
 *
 * `code` is an RFC 9457 extension member: a stable SCREAMING_SNAKE identifier a
 * client can branch on without parsing `type` or matching prose. It exists because
 * sub-phase 0.4.2A returns supported-domain outcomes that a UI must distinguish from
 * one another — `INVITATION_FLOW_NOT_IMPLEMENTED` is a workflow that does not exist
 * yet, `LAST_AGENCY_ADMIN` is an invariant refusal — while every non-enumerating 404
 * deliberately carries no code at all, so the four causes stay indistinguishable
 * (docs/phases/PHASE-0.4.1-IMPLEMENTATION.md §7).
 */
export const problemDetailsSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int().min(100).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  code: z.string().min(1).optional(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
