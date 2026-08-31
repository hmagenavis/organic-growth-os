import { customType } from 'drizzle-orm/pg-core';

/** Case-insensitive text (requires the `citext` extension). */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});

/** Raw bytes — used for hashes and ciphertext, never for readable values. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** IPv4/IPv6 address. */
export const inet = customType<{ data: string; driverData: string }>({
  dataType: () => 'inet',
});

/** Loosely-typed JSON settings column; concrete shapes are validated in `src/settings`. */
export type JsonObject = Record<string, unknown>;
