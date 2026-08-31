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

## Implementation notes (sub-phase 0.3)
- Cookie name is `__Host-organic-os-session` (the planning draft said `ogos_session`;
  `ogos` appears nowhere else in the project). Local HTTP development uses a
  separately named, non-`__Host-` cookie so nothing about making localhost work can
  weaken the production profile.
- The CSRF double-submit token is **signed** (HMAC over binding + nonce), not a bare
  random value: an unsigned double-submit does not survive cookie injection from a
  sibling subdomain. The binding is the session id, or `anonymous` before login.
- Idle 2 h / absolute 12 h by default, both configurable; enforced on every
  resolution, with the absolute cap in SQL and the idle cap in the session service.
- See `docs/phases/PHASE-0.3-IMPLEMENTATION.md`.
