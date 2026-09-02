/**
 * Deterministic, minimal normalization of the three writable site fields.
 *
 * It lives here rather than in `@organic-os/contracts` because it is a domain rule,
 * not a transport rule: the stored value must be the same whether a site is created
 * over HTTP, by a future importer, or by a worker, and `sites` carries
 * `UNIQUE (organization_id, base_url)` — a uniqueness rule is only meaningful if every
 * writer agrees on what "the same URL" means. The API contract validates shape (a
 * non-empty, bounded string); this decides the value.
 *
 * Deliberately *not* a URL canonicalization engine. There is no scheme upgrade, no
 * `www` folding, no trailing-`index.html` removal, no redirect following, no DNS or
 * network lookup of any kind — every one of those is a claim about a site that only
 * the crawler may make, and getting one wrong would silently point the product at a
 * different property. What is done here is exactly what can be decided from the string
 * itself.
 */

export const SITE_BASE_URL_MAX_LENGTH = 2048;
export const SITE_TIMEZONE_MAX_LENGTH = 64;
export const SITE_LANGUAGE_MAX_LENGTH = 35;

export type SiteInputField = 'baseUrl' | 'timezone' | 'language';

/**
 * A writable site field whose value cannot be normalized.
 *
 * Carries the field and a short machine-readable reason for logs and tests. The HTTP
 * layer answers it as a 400 without echoing either: a rejected value is caller input,
 * and reflecting it back into a response body is how a validation message becomes a
 * reflection vector.
 */
export class SiteInputError extends Error {
  readonly field: SiteInputField;
  readonly reason: string;

  constructor(field: SiteInputField, reason: string) {
    super(`Invalid site ${field}: ${reason}`);
    this.name = 'SiteInputError';
    this.field = field;
    this.reason = reason;
  }
}

export function isSiteInputError(value: unknown): value is SiteInputError {
  return value instanceof SiteInputError;
}

/**
 * The stored form of a site's base URL.
 *
 * Accepted: an absolute `http`/`https` URL with a host, and optionally a path.
 * Rejected: any other scheme, embedded credentials, a query string, a fragment, an
 * empty host, and anything the WHATWG parser cannot read at all.
 *
 * Normalized, in this order and nothing beyond it:
 *   * surrounding whitespace removed;
 *   * scheme and host lowercased, and an internationalized host encoded as punycode
 *     (both done by the parser itself, so they cannot drift);
 *   * a default port (`:80` on http, `:443` on https) dropped, a non-default port kept;
 *   * the root-label trailing dot removed — `example.com.` and `example.com` are the
 *     same host, and storing both would defeat the uniqueness constraint;
 *   * trailing slashes removed from the path, so `https://a.test/` and `https://a.test`
 *     are one row. The rest of the path keeps its case, because paths are
 *     case-sensitive and lowercasing one would change which page it names.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed === '') {
    throw new SiteInputError('baseUrl', 'empty');
  }

  if (trimmed.length > SITE_BASE_URL_MAX_LENGTH) {
    throw new SiteInputError('baseUrl', 'too_long');
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    throw new SiteInputError('baseUrl', 'unparseable');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SiteInputError('baseUrl', 'unsupported_scheme');
  }

  if (url.username !== '' || url.password !== '') {
    // Credentials in a site URL are either a mistake or a secret, and this row is
    // read by every member who can see the client.
    throw new SiteInputError('baseUrl', 'credentials_present');
  }

  if (url.search !== '') {
    throw new SiteInputError('baseUrl', 'query_present');
  }

  if (url.hash !== '') {
    throw new SiteInputError('baseUrl', 'fragment_present');
  }

  const hostname = url.hostname.replace(/\.+$/, '');

  if (hostname === '') {
    throw new SiteInputError('baseUrl', 'missing_host');
  }

  const port = url.port === '' ? '' : `:${url.port}`;
  const path = url.pathname.replace(/\/+$/, '');
  const normalized = `${url.protocol}//${hostname}${port}${path}`;

  // The same shape migration 0001 enforces with a CHECK constraint. Asserting it here
  // means a value this function produced can never surface as a constraint violation.
  if (!/^https?:\/\/\S+$/.test(normalized)) {
    throw new SiteInputError('baseUrl', 'unparseable');
  }

  return normalized;
}

/**
 * The stored form of a site's time zone: a canonical IANA identifier.
 *
 * Validated and canonicalized by the platform's own time-zone database rather than by
 * a list maintained here, so `Asia/Jerusalem` is accepted, `utc` becomes `UTC`, and
 * `Mars/Olympus` is refused. Reporting times in a zone the platform does not know
 * would produce a schedule nobody can reason about, which is why this is rejected at
 * the boundary rather than defaulted. A fixed UTC offset is refused for the same
 * reason: it carries no daylight-saving rule.
 */
export function normalizeTimezone(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed === '') {
    throw new SiteInputError('timezone', 'empty');
  }

  if (trimmed.length > SITE_TIMEZONE_MAX_LENGTH) {
    throw new SiteInputError('timezone', 'too_long');
  }

  let canonical: string;

  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    throw new SiteInputError('timezone', 'unknown_timezone');
  }

  // ES2024 also accepts a fixed offset (`+02:00`) as a time zone. A named zone is
  // required instead: a fixed offset has no daylight-saving rule, so every schedule
  // and every reported date for the site would silently shift by an hour twice a year.
  if (/^[+-]/.test(canonical)) {
    throw new SiteInputError('timezone', 'offset_timezone_not_supported');
  }

  return canonical;
}

/** The stored form of a site's language: a canonical BCP-47 tag (`en`, `en-US`, `he`). */
export function normalizeLanguage(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed === '') {
    throw new SiteInputError('language', 'empty');
  }

  if (trimmed.length > SITE_LANGUAGE_MAX_LENGTH) {
    throw new SiteInputError('language', 'too_long');
  }

  let canonical: readonly string[];

  try {
    canonical = Intl.getCanonicalLocales(trimmed);
  } catch {
    throw new SiteInputError('language', 'malformed_language_tag');
  }

  const tag = canonical[0];

  if (tag === undefined) {
    throw new SiteInputError('language', 'malformed_language_tag');
  }

  return tag;
}
