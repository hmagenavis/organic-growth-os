import { z } from 'zod';

/**
 * Who is acting. Recorded on audit entries; never a source of authorization by
 * itself.
 */
export const tenantActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.uuid() }),
  z.object({ kind: z.literal('system') }),
  z.object({ kind: z.literal('worker'), queue: z.string().min(1).max(100) }),
]);

export type TenantActor = z.infer<typeof tenantActorSchema>;

/**
 * The single source of tenancy for every database operation.
 *
 * Repositories read `organizationId` from here and never from their arguments, so a
 * caller cannot widen its own access by passing a different organization id. A
 * context must be derived from something already trusted — an authenticated session
 * (sub-phase 0.3/0.4) or a persisted run/action record (sub-phase 0.5) — and never
 * from an untrusted payload field (docs/SECURITY.md §4).
 */
export const tenantContextSchema = z.object({
  organizationId: z.uuid(),
  actor: tenantActorSchema,
});

export type TenantContext = z.infer<typeof tenantContextSchema>;

export class InvalidTenantContextError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid tenant context: ${issues.join(', ')}`);
    this.name = 'InvalidTenantContextError';
    this.issues = issues;
  }
}

/**
 * Validates a tenant context, failing closed.
 *
 * @throws {InvalidTenantContextError} when the context is absent or malformed.
 */
export function createTenantContext(input: unknown): TenantContext {
  const result = tenantContextSchema.safeParse(input);

  if (!result.success) {
    throw new InvalidTenantContextError(
      result.error.issues.map(
        (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.code}`,
      ),
    );
  }

  return result.data;
}
