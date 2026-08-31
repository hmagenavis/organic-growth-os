# ADR-0018: First-organization provisioning is an operator command, keyed on the slug

Status: Accepted (2026-08-31 — sub-phase 0.4.2A)

## Context

Every organization-scoped feature built so far assumes an organization exists with at
least one `agency_admin` in it. Nothing creates one. Until now the only way to get a
tenant was the test seed helper, which is not a product.

Two constraints shape the answer, and neither is negotiable:

- **Creating an organization or a user requires the provisioning role.** The runtime
  role holds no `INSERT` grant on `organizations` or `users` (migration 0002), and the
  API process opens only the runtime pool. That separation is the reason a compromised
  request handler cannot mint tenants or credentials, and Phase 0.3 already recorded
  it as deliberate.
- **Phase 0 has no way for a person to set their own first credential.** There is no
  invitation flow, no email provider, no password-reset path. Anything that creates an
  account has to obtain a password from somewhere.

The combination rules out the obvious shapes. A public `/signup` endpoint backed by
provisioning credentials would put the privileged connection one request-handler bug
away from the internet. A platform-admin HTTP route group would need its own
authentication, authorization and audit boundary — a sub-phase of its own, for one
operation. And a CLI that takes `--password` on the command line writes the first
administrator's credential into shell history, `ps` output and process listings.

## Decision

**One operator command, `pnpm provision:organization`, and no HTTP surface at all.**

```
pnpm provision:organization --name "Acme Agency" --slug acme --email ada@acme.test
```

- It connects with `DATABASE_PROVISIONER_URL` (`organic_os_provisioner`). No route,
  no request handler and no browser can reach it.
- **Atomic.** Organization, administrator account (when one has to be created) and the
  first `agency_admin` membership commit in a single transaction, including the
  `set_config('app.current_org_id', …, true)` that makes the membership insert legal
  under Row Level Security. Any failure rolls all of it back, so an organization with
  no administrator — a tenant nobody can enter and nobody can repair through the
  application — is never committed.
- **The password is prompted, never an argument.** If the address has no account and
  the command is attached to a terminal, it asks for a name and a password twice with
  the echo suppressed (raw mode, public Node API — not `readline`'s private
  `_writeToOutput`), checks the platform policy, hashes with Argon2id at the
  production baseline, and passes only the encoded hash on. Plaintext never reaches
  `packages/database`, the query log or the database. With stdin redirected the
  command refuses rather than consuming whatever was piped in.
- **Idempotent on the slug.** `INSERT … ON CONFLICT (slug) DO NOTHING`. A retry after a
  timeout finds the existing row and returns the same identifiers with
  `created: false`. A slug that belongs to an organization this command did not create
  — or created with a different first administrator — is refused
  (`organization_slug_taken`) rather than joined.
- **The output carries no secret.** Organization id, user id, membership id, and
  whether anything was created.

The first membership is `agency_admin` with `client_access_mode = all_clients`: the
first administrator of an organization with no clients yet must be able to reach the
ones they are about to create, and `scoped` with zero rows would produce a tenant
nobody can administer.

## Why the slug, and not a separate idempotency key

The slug is `UNIQUE` in the schema, chosen deliberately by the operator, and already
the tenant's stable public identifier. The display **name** is not usable — two
agencies may legitimately both be called "Acme" — and a dedicated idempotency-key
table would add a schema object, a retention question and a cleanup job to protect one
operator command from being run twice.

## Alternatives considered

- **Public self-signup.** Out of scope by the sub-phase brief, and it would put the
  provisioning credential behind an unauthenticated endpoint.
- **A platform-admin HTTP route group.** Deferred. `users.is_platform_admin` exists but
  is read nowhere in the authorization path (0.4.1 §8), and building its route group,
  policy boundary and audit trail to serve one command would be a larger security
  surface than the command itself.
- **An authenticated endpoint that lets an existing agency admin create a *second*
  organization.** Reasonable later; today it would still need the provisioning
  credential inside the API process, which is the thing being avoided.
- **A CLI taking `--password`.** Rejected: shell history and process listings.
- **Seeding through migrations.** Migrations run as the migrator role and must never
  carry tenant data or credentials.

## Consequences

- Standing up a tenant is a deliberate operator act with a shell on the host. That is
  a real operational cost and the right one for Phase 0: there is exactly one
  privileged path, it is not reachable from the network, and it is auditable by
  whoever holds the credential.
- `provisionOrganization`, `provisionUser` and `provisionMembership` remain exported
  for tests and seeding. `provisionFirstOrganization` is the composed, atomic,
  idempotent one that the command uses and that production should use.
- No new migration was needed: the transaction uses grants and policies that
  migration 0002 already defines.
- Creating a *second* organization for an existing user, inviting members by email,
  and any self-service tenant creation remain unbuilt. They belong to 0.4.2B and
  later, and each will need its own decision about where the privilege lives.
- See `docs/phases/PHASE-0.4.2A-IMPLEMENTATION.md` §"Provisioning".
