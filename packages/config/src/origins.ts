import { z } from 'zod';

/**
 * Origin parsing, shared by the server and the client schemas.
 *
 * It lives in its own module, with **no Node builtin imported**, because
 * `./client.ts` is inlined into the browser bundle and may not reach anything that is
 * not. `./http.ts` — which needs `node:net` — is server-only for that reason.
 *
 * An origin is scheme + host + port and nothing else. A path, a query, a fragment,
 * embedded credentials or a wildcard are all refused rather than trimmed away: this
 * value decides who may read a response and where a browser sends a session cookie,
 * and quietly repairing a malformed one is how the wrong thing gets trusted.
 */

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Parses one origin, returning its normalised form.
 *
 * @throws {Error} with the rule that was broken. The offending value is never part of
 * the message — it reaches a log line, and the rule is what an operator needs.
 */
export function parseOrigin(entry: string): string {
  if (entry.includes('*')) {
    throw new Error('wildcards are not accepted; give each origin exactly');
  }

  let url: URL;

  try {
    url = new URL(entry);
  } catch {
    throw new Error('must be an absolute origin, e.g. https://app.example.com');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('must use http or https');
  }

  if (url.username !== '' || url.password !== '') {
    throw new Error('an origin must not carry credentials');
  }

  if (url.search !== '' || url.hash !== '' || entry.replace(/\/+$/, '') !== url.origin) {
    throw new Error('must be an origin only — no path, query or fragment');
  }

  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.host.replace(/:\d+$/, ''))) {
    // A credentialed cross-origin request over plaintext is a downgrade, so it is
    // refused at configuration time rather than at request time.
    throw new Error('only a loopback origin may use http; everything else must be https');
  }

  return url.origin;
}

/**
 * Parses a comma-separated allowlist into exact origins.
 *
 * Empty (the default) means **no** grant at all, which is the correct value for a
 * same-origin deployment: it is not a permissive fallback, it is the absence of a
 * grant.
 */
export function parseAllowedOrigins(raw: string): readonly string[] {
  const origins: string[] = [];

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();

    if (trimmed === '') {
      continue;
    }

    const origin = parseOrigin(trimmed);

    if (!origins.includes(origin)) {
      origins.push(origin);
    }
  }

  return origins;
}

/**
 * Wraps a parser so a failure becomes a Zod issue carrying the rule that was broken
 * and never the value that broke it.
 *
 * The default is applied to the raw string before parsing, so an absent variable and
 * the default text take exactly the same path — there is no second code path in which
 * a missing value could produce something the parser would have refused.
 */
export function refinedString<T>(parse: (raw: string) => T, fallback: string) {
  return z
    .string()
    .default(fallback)
    .transform((raw, ctx): T => {
      try {
        return parse(raw);
      } catch (error: unknown) {
        ctx.addIssue({
          code: 'custom',
          message: error instanceof Error ? error.message : 'invalid value',
        });
        return z.NEVER;
      }
    });
}

export const allowedOriginsSchema = refinedString(parseAllowedOrigins, '');
