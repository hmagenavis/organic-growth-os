import type { Transaction } from '../client.js';
import type { TenantContext } from '../tenant/context.js';
import { createAuditLogRepository, type AuditLogRepository } from './audit-logs.js';
import { createClientRepository, type ClientRepository } from './clients.js';
import {
  createMembershipClientScopeRepository,
  type MembershipClientScopeRepository,
} from './membership-client-scopes.js';
import { createMembershipRepository, type MembershipRepository } from './memberships.js';
import { createOrganizationRepository, type OrganizationRepository } from './organizations.js';
import { createSiteSettingsRepository, type SiteSettingsRepository } from './site-settings.js';
import { createSiteRepository, type SiteRepository } from './sites.js';

/**
 * The complete tenant-scoped data surface.
 *
 * This is the only way application code reaches the database: there is no exported
 * escape hatch that runs arbitrary SQL, and every repository derives its
 * organization from `tenant` rather than from its arguments.
 */
export interface TenantRepositories {
  readonly tenant: TenantContext;
  readonly organizations: OrganizationRepository;
  readonly clients: ClientRepository;
  readonly sites: SiteRepository;
  readonly siteSettings: SiteSettingsRepository;
  readonly memberships: MembershipRepository;
  readonly membershipClientScopes: MembershipClientScopeRepository;
  readonly auditLogs: AuditLogRepository;
}

export function createTenantRepositories(
  tx: Transaction,
  tenant: TenantContext,
): TenantRepositories {
  return {
    tenant,
    organizations: createOrganizationRepository(tx, tenant),
    clients: createClientRepository(tx, tenant),
    sites: createSiteRepository(tx, tenant),
    siteSettings: createSiteSettingsRepository(tx, tenant),
    memberships: createMembershipRepository(tx, tenant),
    membershipClientScopes: createMembershipClientScopeRepository(tx, tenant),
    auditLogs: createAuditLogRepository(tx, tenant),
  };
}

export type {
  AuditLogRepository,
  ClientRepository,
  MembershipClientScopeRepository,
  MembershipRepository,
  OrganizationRepository,
  SiteRepository,
  SiteSettingsRepository,
};
export type { AppendAuditLogInput, AuditLogRecord } from './audit-logs.js';
export { InvalidClientCursorError, isInvalidClientCursorError } from './clients.js';
export type {
  ClientListAccess,
  ClientPage,
  ClientPageRequest,
  ClientRecord,
  CreateClientInput,
  UpdateClientInput,
} from './clients.js';
export type {
  AddMembershipClientScopeInput,
  MembershipClientScopeRecord,
} from './membership-client-scopes.js';
export type { CreateMembershipInput, MembershipRecord, MembershipWithUser } from './memberships.js';
export type { OrganizationRecord, UpdateOrganizationInput } from './organizations.js';
export type { SiteSettingsRecord, UpdateSiteSettingsInput } from './site-settings.js';
export type { CreateSiteInput, SiteRecord, UpdateSiteInput } from './sites.js';
