/**
 * Guards the invariant that a write returning rows produced exactly one.
 *
 * A blocked write does not reach here: Row Level Security rejects it with an error,
 * and a filtered read returns an empty array that callers map to `null`.
 */
export function requireRow<T>(rows: readonly T[], operation: string): T {
  const row = rows[0];

  if (row === undefined) {
    throw new Error(`${operation} returned no row`);
  }

  return row;
}
