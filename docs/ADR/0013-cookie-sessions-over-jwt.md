# ADR-0013: Server-side cookie sessions instead of JWTs

Status: Accepted (2026-08-31 — accepted with the Phase 0 go decision)

## Context
PRD §141 requires secure session management, revocation, and secure cookies. The
dashboard is a first-party web app; there is no third-party API consumer in MVP.

## Decision
Opaque session tokens (256-bit, stored hashed in Postgres), delivered via
`__Host-`-prefixed HttpOnly Secure SameSite=Lax cookie; CSRF double-submit token for
mutations; idle + absolute expiry; rotation on privilege change; server-side
revocation (logout, admin force-logout, integration-revocation cascades).

## Alternatives considered
- JWT access/refresh: instant revocation impossible without a denylist (which is just
  a session store with extra steps); key rotation complexity; no MVP benefit since
  there are no stateless third-party consumers.
- Auth SaaS (Clerk/Auth0): external dependency for the security-critical core of a
  multi-tenant product + per-MAU cost; revisit only if SSO demands arrive.

## Consequences
- Every request costs a session lookup (cached in Redis with short TTL if it ever
  shows up in p95).
- A future public API gets separate API keys — a different mechanism by design.
