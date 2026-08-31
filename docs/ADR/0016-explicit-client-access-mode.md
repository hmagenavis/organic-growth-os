# ADR-0016: Explicit `client_access_mode` on a membership

Status: Accepted (2026-08-31 — sub-phase 0.4.1). Amends SECURITY.md §3 and
DATA-MODEL.md §3 as written for Phase 0.2.

## Context

The Phase-0.2 model normalised client-level restriction into
`membership_client_scopes` and gave the empty collection a meaning by convention:

> rows present = membership is limited to those clients; no rows = all clients the
> role permits.

That convention makes an empty collection mean **ALL** to code that knows it and
**NONE** to code that takes the collection at face value. Both readings are reasonable
to a developer looking at `scopes.includes(clientId)`, and the difference between them
is a privilege escalation. It is also indistinguishable from "an administrator started
scoping this membership and has not added the first client yet".

## Decision

State the mode on the membership row:

```sql
CREATE TYPE client_access_mode AS ENUM ('all_clients', 'scoped');
ALTER TABLE memberships ADD COLUMN client_access_mode client_access_mode NOT NULL;  -- no DEFAULT
```

- `all_clients` — every client of the organization, subject to the role.
- `scoped` — only the clients listed in `membership_client_scopes`. **Zero rows means
  zero clients.**

The column has **no database default**, and `provisionMembership` /
`MembershipRepository.create` both require the value, so a membership cannot be created
without a decision that someone made on purpose.

`client_viewer` is constrained to `scoped` by a `CHECK`, because SECURITY.md §3 makes
client restriction mandatory for that role and a constraint is cheaper to trust than a
code path.

## Alternatives considered

- **Keep the convention and document it harder.** Documentation does not survive the
  next person writing `scopes.length === 0`.
- **A sentinel row meaning "all".** A magic row in a table of real client ids; every
  join has to know about it.
- **Infer the mode from the role.** Would hardcode policy into the schema and make
  "an `analyst` restricted to two clients" unexpressible.

## Consequences

- Migration 0004 backfills forward-only: `scoped` where scope rows exist, `scoped`
  unconditionally for `client_viewer` (a narrowing, which is the safe direction),
  `all_clients` otherwise — which preserves exactly what every existing row meant under
  the old convention, except for the `client_viewer` narrowing that SECURITY.md always
  intended.
- Authorizing a client resource now requires **both** a role permission and the client
  access check, plus proof that the client belongs to the authorized organization.
  `withAuthorizedOrganization(...).requireClient()` is the only place all three are
  composed.
- SECURITY.md §3 and DATA-MODEL.md §3 are updated; the sentence describing the old
  convention is gone rather than annotated, so nothing can be read the old way.
- See `docs/phases/PHASE-0.4.1-IMPLEMENTATION.md`.
