/**
 * Test-only helpers.
 *
 * Reachable only through the `@organic-os/authorization/testing` subpath so nothing
 * in the production entry point can import them by accident.
 */
export { InMemoryMembershipStore, type SeedMembershipInput } from './in-memory-store.js';
