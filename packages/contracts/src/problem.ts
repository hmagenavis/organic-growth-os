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
 */
export const problemDetailsSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int().min(100).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
