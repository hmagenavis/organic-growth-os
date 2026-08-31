# ADR-0017: Membership change and session revocation commit in one transaction

Status: Accepted (2026-08-31 — sub-phase 0.4.2A)

## Context

Sub-phase 0.4.2A adds the mutations that change what an existing member may do: role
changes, client-scope changes and removal. Each of them has to be accompanied by
server-side session revocation for the affected user, because a session established
under the old authorization must not survive the change (SECURITY.md §2–§3).

That gives two writes which must agree:

1. the membership row, in `memberships` / `membership_client_scopes` — tenant-scoped,
   under `FORCE ROW LEVEL SECURITY`, reachable only with `app.current_org_id` set;
2. the affected user's rows in `sessions`.

The dangerous state is *membership changed, sessions still live*. A demoted member
keeps browsing with the authority they had a moment ago, and nothing in the system
knows it happened. Two separate transactions produce that state in two ordinary ways:
the revocation fails after the membership commits, or the process dies between them.
Retries and compensating writes shrink the window; they do not close it.

`SessionService.revokeAllForUser` (Phase 0.3) is the right *primitive*, but it reaches
the database through `AuthStore`, which opens its own transaction per call. Using it
from a membership mutation is exactly the two-transaction shape above.

## Decision

**Perform the membership mutation and the session revocation in a single database
transaction** — the authorized tenant transaction that `withAuthorizedOrganization`
already opens — and append the tenant audit record in the same transaction.

This is possible without weakening anything, because of a property migration 0002
established for an unrelated reason: `sessions` is deliberately **outside Row Level
Security**. A session is resolved from a token hash before any organization is known,
so a tenant predicate could not be evaluated on it. The runtime role therefore holds a
plain `UPDATE` grant on `sessions` with no policy to satisfy, and that statement is
legal inside a transaction that already carries `app.current_org_id` for the
membership write.

The capability is exposed as exactly one method on the authorized session:

```ts
AuthorizedOrganizationSession.revokeMemberSessions(membership: MembershipRecord): Promise<number>
```

- it takes a **membership record**, which can only be obtained from a tenant-scoped
  repository, and re-checks `membership.organizationId` against the authorized
  context, so an administrator of organization A cannot log out a member of B;
- it revokes; it does not rotate. Rotation replaces the *caller's own* session and
  needs the raw cookie token, which an administrator acting on someone else does not
  have and must never be given;
- the raw transaction handle is not exposed. One narrow method is the whole surface.

Session revocation policy (the matrix is in
`docs/phases/PHASE-0.4.2A-IMPLEMENTATION.md`): removal, role change, and any
*narrowing* of client access revoke every session of the affected user. Broadening
does not, because nothing that was permitted stops being permitted and authorization
is re-proven per request. Any ambiguous change is treated as narrowing.

## Alternatives considered

- **Best-effort revocation after the membership commits.** The dangerous state above,
  with a comment apologising for it.
- **An outbox row plus a worker.** Correct eventually, and eventual is the wrong
  guarantee for a privilege reduction. It also invents a queue dependency in a
  sub-phase that has none (Redis and BullMQ are §0.5).
- **A compensating "undo the membership change" write when revocation fails.** A
  second mutation that can itself fail, on the path where things are already failing.
- **Bringing `sessions` under RLS so the whole thing is tenant-scoped.** `sessions`
  has no organization column and cannot get one: a session is identity, not tenancy.
  This would break authentication to fix a problem that has a simpler answer.
- **Distributed transaction / two-phase commit across two pools.** Enormous machinery
  for two tables in the same database.

## Consequences

- A membership mutation, the revocation it forces and the audit record it produces are
  one commit. There is no partially-applied security mutation to detect, alert on or
  repair — asserted by an integration test that makes the transaction throw *after*
  all three writes and observes that none of them survived.
- `packages/database` is the only package that can do this, which is consistent with
  its existing role: it owns transactions (see the 0.4.1 rationale for placing
  `withAuthorizedOrganization` there rather than in `@organic-os/authorization`).
- `@organic-os/auth` is unchanged. `SessionService` keeps its own primitives for the
  authentication paths — logout, rotation, cleanup — and remains the only place
  session *lifetime policy* lives.
- The authorized tenant session now touches one table outside the tenant boundary.
  That is a genuinely wider surface than 0.4.1 had, and it is narrowed by
  construction: one method, taking a record that only a tenant-scoped repository can
  produce, with an organization re-check inside.
- Long-running administrative transactions now hold row locks on `memberships` while
  also writing `sessions`. Both writes are point updates on indexed columns, and
  `idle_in_transaction_session_timeout` (15 s, set as a connection option) bounds any
  transaction that stalls.
- See `docs/phases/PHASE-0.4.2A-IMPLEMENTATION.md` §"Session invalidation" and
  §"Atomicity".
