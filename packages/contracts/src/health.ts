import { z } from 'zod';

/**
 * Response contract for service health endpoints.
 *
 * Deliberately carries no tenant, environment or dependency detail: health is a
 * public-facing liveness signal and must never leak internal topology.
 */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string().min(1),
  version: z.string().min(1),
  uptimeSeconds: z.number().int().nonnegative(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
