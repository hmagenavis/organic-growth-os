import { z } from 'zod';

import { EnvValidationError, toEnvIssues } from './errors.js';
import { parseOrigin } from './origins.js';

/**
 * PUBLIC configuration — safe to ship to the browser.
 *
 * Only `NEXT_PUBLIC_*` variables belong here. Nothing in this module may import from
 * `./server.js`, and no secret may ever be added to this schema: everything defined
 * here is inlined into the client bundle and is world-readable.
 */

export const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_NAME: z.string().min(1).default('Organic Growth OS'),

  /**
   * Origin of the API the browser talks to, e.g. `https://api.example.com`.
   *
   * Public by definition and safe to be: it is a hostname the browser has to know in
   * order to send a request at all. It is **infrastructure, not a credential** — the
   * session is a `__Host-` cookie the browser attaches to that origin, and nothing
   * about knowing the address grants access to anything.
   *
   * Validated as an origin rather than accepted as a string: a path or a trailing
   * slash here would silently produce `https://api.example.com//auth/login`, and a
   * plaintext origin would send a credentialed request over an unencrypted channel.
   *
   * Optional, because a deployment that serves no browser call to the API needs no
   * value and must not be given a guessed default (docs/cloud/API-STAGING.md §7).
   */
  NEXT_PUBLIC_API_BASE_URL: z
    .string()
    .optional()
    .transform((raw, ctx): string | undefined => {
      // A variable a platform declared and left blank means "unset". Anything else is
      // parsed strictly, and a failure names the rule rather than the value.
      if (raw === undefined || raw.trim() === '') {
        return undefined;
      }

      try {
        return parseOrigin(raw.trim());
      } catch (error: unknown) {
        ctx.addIssue({
          code: 'custom',
          message: error instanceof Error ? error.message : 'invalid value',
        });
        return z.NEVER;
      }
    }),
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
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  });
}

export { EnvValidationError, type EnvIssue } from './errors.js';
