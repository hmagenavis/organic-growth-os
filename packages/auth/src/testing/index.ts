/**
 * Test-only helpers.
 *
 * Reachable only through the `@organic-os/auth/testing` subpath so nothing in the
 * production entry point can import them by accident.
 */
export { InMemoryAuthStore } from './in-memory-store.js';
