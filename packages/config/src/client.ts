import { z } from 'zod';

import { EnvValidationError, toEnvIssues } from './errors.js';

/**
 * PUBLIC configuration — safe to ship to the browser.
 *
 * Only `NEXT_PUBLIC_*` variables belong here. Nothing in this module may import from
 * `./server.js`, and no secret may ever be added to this schema: everything defined
 * here is inlined into the client bundle and is world-readable.
 */

export const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_NAME: z.string().min(1).default('Organic Growth OS'),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

/**
 * Validates a public environment source. Unknown keys are stripped, so a secret that
 * is accidentally passed in cannot survive into the returned object.
 *
 * @throws {EnvValidationError} when a public variable is malformed.
 */
export function parsePublicEnv(source: Readonly<Record<string, string | undefined>>): PublicEnv {
  const result = publicEnvSchema.safeParse(source);

  if (!result.success) {
    throw new EnvValidationError(toEnvIssues(result.error.issues));
  }

  return result.data;
}

/**
 * Public configuration for the current process/bundle.
 *
 * Each variable is read through a static property access (`process.env.NEXT_PUBLIC_X`)
 * so bundlers can statically replace it; passing `process.env` wholesale would break
 * that replacement and is never done here.
 */
export function publicEnv(): PublicEnv {
  return parsePublicEnv({
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  });
}

export { EnvValidationError, type EnvIssue } from './errors.js';
