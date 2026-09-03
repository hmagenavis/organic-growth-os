import { isIP } from 'node:net';

import { refinedString } from './origins.js';

/**
 * The proxy trust boundary: who this process believes when it reads
 * `x-forwarded-for`.
 *
 * SERVER-ONLY. Reachable through `@organic-os/config/server` and nowhere else — it
 * imports a Node builtin and must never be pulled into a browser bundle. Origin
 * parsing, which the client schema also needs, lives in `./origins.ts` for that
 * reason.
 *
 * This was `false` through Phase 0.4 because nothing sat in front of the API. Cloud
 * 0.2 puts a managed platform's TLS terminator there, which makes it a real security
 * decision rather than a default (docs/cloud/API-STAGING.md §5).
 */

/**
 * What Fastify's `trustProxy` is set to.
 *
 * `false` means `request.ip` is the socket peer and cannot be forged with a header —
 * the Phase 0.3 posture, and still the default here.
 */
export type TrustProxyConfig = false | readonly string[];

/** Fastify's named address groups, accepted verbatim. */
const NAMED_PROXY_GROUPS: ReadonlySet<string> = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isAddressOrCidr(entry: string): boolean {
  const separator = entry.indexOf('/');

  if (separator === -1) {
    return isIP(entry) !== 0;
  }

  const family = isIP(entry.slice(0, separator));
  const prefix = entry.slice(separator + 1);

  if (family === 0 || !/^\d{1,3}$/.test(prefix)) {
    return false;
  }

  return Number(prefix) <= (family === 4 ? 32 : 128);
}

/**
 * Parses `API_TRUST_PROXY`.
 *
 * Accepted: `false` (or absent), or a comma-separated list of addresses, CIDR blocks
 * and Fastify's named groups (`loopback`, `linklocal`, `uniquelocal`). Anything else is
 * refused, and the two refusals are the substance of this function.
 *
 * **`true` is refused.** It tells Fastify to believe `x-forwarded-for` from anyone, and
 * on a managed host whose public URL the whole internet can reach that turns the login
 * rate-limit key and every `sessions.ip` row into an attacker-supplied string.
 *
 * **A hop count is refused**, which is less obvious and matters more. `fastify@5.12.1`
 * maps a numeric `trustProxy` to a function that trusts *nothing* (`lib/request.js`,
 * `getTrustProxyFn`) precisely because a hop count cannot validate the immediate peer.
 * So `API_TRUST_PROXY=1` would read as configured, behave as `false`, and quietly leave
 * `request.ip` pointing at the platform's load balancer. Refusing it turns a silent
 * no-op into a startup failure.
 *
 * What remains is the only form that is actually enforced: name the peer. On a managed
 * container platform the process is reached from inside the platform network, so
 * `uniquelocal` — trust a peer in private address space, which no internet client can
 * be — is the narrow, checkable boundary (docs/cloud/API-STAGING.md §5).
 */
export function parseTrustProxy(raw: string): TrustProxyConfig {
  const value = raw.trim().toLowerCase();

  if (value === '' || value === 'false') {
    return false;
  }

  if (value === 'true') {
    throw new Error(
      'must not be `true`: name the addresses of the proxies in front of this process',
    );
  }

  if (/^\d+$/.test(value)) {
    throw new Error(
      'a hop count is not enforced by Fastify and would silently trust nothing; name the proxy addresses instead',
    );
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  if (entries.length === 0) {
    throw new Error('must be `false` or a list of addresses');
  }

  for (const entry of entries) {
    if (!NAMED_PROXY_GROUPS.has(entry) && !isAddressOrCidr(entry)) {
      // The offending entry is not echoed: this message reaches a log line, and the
      // rule is what an operator needs, not the typo.
      throw new Error(
        'entries must be IP addresses, CIDR blocks, or one of loopback/linklocal/uniquelocal',
      );
    }
  }

  return entries;
}

export const trustProxySchema = refinedString(parseTrustProxy, 'false');
