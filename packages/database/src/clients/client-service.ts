import { AuthorizationError, type AuthenticatedIdentityRef } from '@organic-os/authorization';

import type { AdministrationRequest } from '../administration/membership-administration.js';
import type {
  AuthorizationService,
  AuthorizedOrganizationSession,
} from '../authorization/with-authorized-organization.js';
import type { ClientListAccess, ClientRecord } from '../repositories/clients.js';
import type { JsonObject } from '../schema/columns.js';
import type { ClientStatus } from '../schema/enums.js';

/**
 * Clients: the first tenant business resource with an API (Phase 0.4.2B1).
 *
 * The shape is deliberately the same as member administration next door, because the
 * property it protects is the same one: an HTTP handler must not be able to reach a
 * repository, and every path to tenant data must go through
 * `withAuthorizedOrganization`. What differs is the authorization rule, and it is the
 * point of this sub-phase:
 *
 *   **authorized = role permission AND client access scope.**
 *
 * Neither half is sufficient. `client.read` alone does not open a client, because a
 * `scoped` membership reaches only the clients listed in `membership_client_scopes`;
 * and being listed there does not open a client either, because the role must hold
 * the permission. `session.requireClient` composes both, together with proof that the
 * client belongs to the authorized organization, and it is the only way a client is
 * reached here.
 *
 * The listing applies exactly the same rule, one query lower: the `scoped` branch of
 * `listAuthorizedPage` inner-joins the scope rows in PostgreSQL, so the filter cannot
 * drift away from the single-resource check and cannot be skipped by forgetting a
 * JavaScript predicate.
 *
 * Deletion and archival are deliberately absent. They cascade into sites, settings,
 * scopes and eventually into SEO state that does not exist yet, and a lifecycle
 * designed around today's four tables would be the wrong one. Until then a client is
 * created `active` and stays `active`; `status` is reported but not writable
 * (§3 of the sub-phase brief).
 */

/**
 * One client, as the API reports it.
 *
 * `organizationId` is deliberately absent. It is not a secret — the caller supplied
 * it in the path — but a business object that carries a tenant identifier invites
 * code that reads it back as authorization, and there is no reason to hand it out
 * twice.
 */
export interface ClientView {
  readonly id: string;
  readonly name: string;
  readonly status: ClientStatus;
  readonly industry: string | null;
  readonly notes: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ListClientsQuery {
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface ClientListResult {
  readonly clients: readonly ClientView[];
  readonly limit: number;
  readonly nextCursor: string | null;
}

/** No `organizationId` and no `status`: one comes from context, the other is deferred. */
export interface CreateClientRequest {
  readonly name: string;
  readonly industry?: string | null | undefined;
  readonly notes?: string | null | undefined;
}

/**
 * The mutable half of a client, and nothing else.
 *
 * An explicit optional field per column rather than a partial record, so adding a
 * column to `clients` cannot silently make it patchable. `null` clears a nullable
 * field; an absent key leaves it alone.
 */
export interface UpdateClientPatch {
  readonly name?: string | undefined;
  readonly industry?: string | null | undefined;
  readonly notes?: string | null | undefined;
}

export interface ClientService {
  listClients(
    identity: AuthenticatedIdentityRef,
    organizationId: string,
    query: ListClientsQuery,
  ): Promise<ClientListResult>;

  getClient(
    identity: AuthenticatedIdentityRef,
    organizationId: string,
    clientId: string,
  ): Promise<ClientView>;

  createClient(
    identity: AuthenticatedIdentityRef,
    organizationId: string,
    input: CreateClientRequest,
    request: AdministrationRequest,
  ): Promise<ClientView>;

  updateClient(
    identity: AuthenticatedIdentityRef,
    organizationId: string,
    clientId: string,
    patch: UpdateClientPatch,
    request: AdministrationRequest,
  ): Promise<ClientView>;
}

export interface ClientServiceOptions {
  readonly authorization: AuthorizationService;
}

/** A client this organization cannot reach reads as absent, never as forbidden. */
function clientNotReachable(): AuthorizationError {
  return new AuthorizationError('resource_not_in_organization', { resource: 'client' });
}

function toClientView(row: ClientRecord): ClientView {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    industry: row.industry,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The audit `before`/`after` payload.
 *
 * `notes` is reported as a boolean rather than as text, and that is the one
 * deliberate omission here. It is the only free-form field on `clients`, which makes
 * it the field most likely to accumulate a customer contact's name, address or phone
 * number — and `audit_logs` is append-only by privilege, so anything written into it
 * cannot be corrected or erased afterwards. Recording *that* the notes changed keeps
 * the trail readable; the current text is always one read away on the client itself.
 * The same reasoning kept email and name out of the membership audit payload in
 * sub-phase 0.4.2A.
 *
 * Nothing else on `clients` is sensitive: the table holds no credential, no token and
 * no integration setting, and none of the request's cookies, CSRF token or session
 * data is reachable from this module at all.
 */
function auditState(view: ClientView): JsonObject {
  return {
    name: view.name,
    status: view.status,
    industry: view.industry,
    notesPresent: view.notes !== null && view.notes !== '',
  };
}

/**
 * The listing rule, derived from the *context* rather than from anything a caller
 * sent.
 *
 * `all_clients` lists the organization; `scoped` lists the intersection with this
 * membership's scope rows. The membership id comes from the proven membership, so a
 * caller cannot list another membership's clients by naming it.
 */
function listAccessFor(session: AuthorizedOrganizationSession): ClientListAccess {
  return session.context.clientAccessMode === 'all_clients'
    ? { mode: 'all_clients' }
    : { mode: 'scoped', membershipId: session.context.membershipId };
}

/** Whether the patch would actually change the stored row. */
function isEffectiveChange(current: ClientRecord, patch: UpdateClientPatch): boolean {
  if (patch.name !== undefined && patch.name !== current.name) {
    return true;
  }
  if (patch.industry !== undefined && (patch.industry ?? null) !== current.industry) {
    return true;
  }
  if (patch.notes !== undefined && (patch.notes ?? null) !== current.notes) {
    return true;
  }

  return false;
}

export function createClientService(options: ClientServiceOptions): ClientService {
  const { authorization } = options;

  return {
    async listClients(identity, organizationId, query): Promise<ClientListResult> {
      return authorization.withAuthorizedOrganization(identity, organizationId, async (session) => {
        // Role first. A caller whose role holds no `client.read` is refused before a
        // single client row is read, so the refusal says nothing about what exists.
        session.require('client.read');

        const page = await session.repositories.clients.listAuthorizedPage(listAccessFor(session), {
          limit: query.limit,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        });

        return {
          clients: page.clients.map(toClientView),
          limit: query.limit,
          nextCursor: page.nextCursor,
        };
      });
    },

    async getClient(identity, organizationId, clientId): Promise<ClientView> {
      return authorization.withAuthorizedOrganization(identity, organizationId, async (session) => {
        // Permission, organization ownership and client scope — all three, in that
        // order, before the row is returned to anybody.
        await session.requireClient('client.read', clientId);

        const client = await session.repositories.clients.findById(clientId);

        if (client === null) {
          // Only reachable if the row disappeared between the two reads.
          throw clientNotReachable();
        }

        return toClientView(client);
      });
    },

    async createClient(identity, organizationId, input, request): Promise<ClientView> {
      return authorization.withAuthorizedOrganization(identity, organizationId, async (session) => {
        session.require('client.create');

        // `organization_id` is not an argument: the repository takes it from the
        // tenant context, which came from the proven membership. A body that carried
        // one never reaches here — the contract rejects unknown fields — and could
        // not be honoured if it did.
        const created = await session.repositories.clients.create({
          name: input.name,
          ...(input.industry === undefined ? {} : { industry: input.industry }),
          ...(input.notes === undefined ? {} : { notes: input.notes }),
        });

        const view = toClientView(created);

        // Same transaction as the insert. No scope row is written for anybody: a
        // membership with `all_clients` reaches the new client by policy, and a
        // `scoped` membership — including the creator's own, if they are scoped —
        // does not, until an administrator says so through the member-scope API.
        // Widening every scoped membership on create would quietly undo the explicit
        // scope administration sub-phase 0.4.2A exists to provide (§9).
        await session.repositories.auditLogs.append({
          action: 'client.created',
          targetType: 'client',
          targetId: created.id,
          before: null,
          after: auditState(view),
          source: request.source,
          result: 'ok',
          ip: request.ip,
        });

        return view;
      });
    },

    async updateClient(identity, organizationId, clientId, patch, request): Promise<ClientView> {
      return authorization.withAuthorizedOrganization(identity, organizationId, async (session) => {
        // Permission AND scope, both. An `agency_admin` whose own membership is
        // `scoped` cannot mutate a client outside that scope: the role grants the
        // verb, not the reach.
        await session.requireClient('client.update', clientId);

        // Locked before it is read, so the audit `before` is the state the update is
        // actually applied to rather than a snapshot another transaction has since
        // moved on from.
        const locked = await session.repositories.clients.lockById(clientId);

        if (locked === null) {
          throw clientNotReachable();
        }

        if (!isEffectiveChange(locked, patch)) {
          // Idempotent: nothing changed, so `updated_at` does not move and no audit
          // row is written. Recording a mutation that did not happen would make the
          // trail less trustworthy, not more.
          return toClientView(locked);
        }

        const before = toClientView(locked);

        const updated = await session.repositories.clients.update(clientId, {
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.industry === undefined ? {} : { industry: patch.industry }),
          ...(patch.notes === undefined ? {} : { notes: patch.notes }),
        });

        if (updated === null) {
          throw clientNotReachable();
        }

        const after = toClientView(updated);

        await session.repositories.auditLogs.append({
          action: 'client.updated',
          targetType: 'client',
          targetId: clientId,
          before: auditState(before),
          after: auditState(after),
          source: request.source,
          result: 'ok',
          ip: request.ip,
        });

        return after;
      });
    },
  };
}
