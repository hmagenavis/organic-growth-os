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

/**
 * Response contract for the readiness endpoint.
 *
 * Liveness asks "is the process running"; readiness asks "can it serve traffic".
 * A load balancer needs both, so they are separate endpoints with separate shapes.
 *
 * Deliberately carries no reason, no dependency name and no error text: a readiness
 * probe is reachable by anyone who can reach the service, and "which dependency is
 * down" is topology (docs/SECURITY.md §8). The reason is logged server-side.
 */
export const readinessResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  service: z.string().min(1),
  version: z.string().min(1),
});

export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
