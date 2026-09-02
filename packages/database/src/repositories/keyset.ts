/**
 * Keyset (cursor) pagination primitives.
 *
 * Extracted from the client repository in sub-phase 0.4.2B2 because the site
 * collection pages on exactly the same total order — `(created_at, id)` ascending —
 * and copying the encoder, the decoder and their two regular expressions into a
 * second repository would have created two places for the cursor format to drift
 * apart in.
 *
 * This is deliberately **not** a pagination framework. There is no query builder, no
 * generic `Page<T>`, no configurable ordering and no shared error type: each
 * repository still writes its own keyset predicate against its own table, states its
 * own limits, and throws its own cursor error so the API layer can keep mapping each
 * collection's failures separately. What is shared is only the wire format of a
 * cursor and the bound on a page size.
 */

/** One row's position in the `(created_at, id)` ordering. */
export interface KeysetPosition {
  /**
   * `created_at` as PostgreSQL rendered it, at full precision — never a JavaScript
   * `Date`. See `encodeKeysetCursor`.
   */
  readonly createdAt: string;
  readonly id: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `2026-09-02 11:22:33.123456+00` — PostgreSQL's own timestamptz text rendering. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

/**
 * Encodes the position of the last row of a page.
 *
 * The timestamp is the value PostgreSQL rendered, not a JavaScript `Date`: a
 * `timestamptz` carries microseconds and a `Date` only milliseconds, so a cursor built
 * from a `Date` would round `12:00:00.000500` down to `12:00:00.000` and hand the same
 * row back on the next page. Round-tripping the database's own text keeps the
 * comparison exact.
 *
 * Base64url is encoding, not protection: the cursor holds the `created_at` and `id` of
 * a row the caller was just given, so there is nothing in it to protect. It is opaque
 * so the ordering can change later without breaking callers.
 */
export function encodeKeysetCursor(position: KeysetPosition): string {
  return Buffer.from(`${position.createdAt}|${position.id}`, 'utf8').toString('base64url');
}

/**
 * Decodes a cursor, or refuses.
 *
 * `onInvalid` supplies the error so each collection keeps its own cursor error type
 * and the HTTP layer's existing per-collection mapping is unchanged.
 *
 * @throws whatever `onInvalid` returns, for anything this ordering cannot resume from.
 */
export function decodeKeysetCursor(cursor: string, onInvalid: () => Error): KeysetPosition {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf('|');

  if (separator === -1) {
    throw onInvalid();
  }

  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);

  // Both halves are bound as query parameters by the caller, so this is not injection
  // defence — it is refusing to turn caller-supplied text into a database error.
  if (!TIMESTAMP_PATTERN.test(createdAt) || !UUID_PATTERN.test(id)) {
    throw onInvalid();
  }

  return { createdAt, id };
}

/**
 * The page size actually used, independent of whatever the HTTP contract allowed.
 *
 * The API refuses an over-maximum limit rather than clamping it; this exists so the
 * bound still holds for a caller that reaches a repository directly.
 */
export function clampPageLimit(limit: number, maximum: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), maximum);
}
