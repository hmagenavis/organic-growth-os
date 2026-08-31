import { v7 as uuidv7 } from 'uuid';

/**
 * Generates a primary key.
 *
 * UUIDv7 is time-ordered, so inserts stay local at the right edge of B-tree indexes
 * instead of scattering like UUIDv4 — the reason DATA-MODEL.md §1 specifies it.
 * Generation is application-side because PostgreSQL only gained a built-in
 * `uuidv7()` in version 18 and the platform targets 16+; `uuid` is the smallest
 * maintained implementation (no runtime dependencies of its own), so no bespoke ID
 * service is warranted.
 */
export function newId(): string {
  return uuidv7();
}
