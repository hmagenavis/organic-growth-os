/**
 * Public surface of the database package.
 *
 * Deliberately narrow: the Drizzle table objects are NOT exported, so application
 * code cannot assemble an unscoped query. Tenant data is reachable only through
 * `withTenantTransaction`, which hands out repositories bound to a validated tenant
 * context inside a transaction (ADR-0002, docs/SECURITY.md §4).
 */

export {
  createDatabase,
  type CreateDatabaseOptions,
  type Database,
  type DatabaseHandle,
} from './client.js';

export {
  createTenantContext,
  InvalidTenantContextError,
  tenantActorSchema,
  tenantContextSchema,
  type TenantActor,
  type TenantContext,
} from './tenant/context.js';

export { withTenantTransaction } from './tenant/with-tenant-transaction.js';

export type {
  AddMembershipClientScopeInput,
  AppendAuditLogInput,
  AuditLogRecord,
  AuditLogRepository,
  ClientRecord,
  ClientRepository,
  CreateClientInput,
  CreateMembershipInput,
  CreateSiteInput,
  MembershipClientScopeRecord,
  MembershipClientScopeRepository,
  MembershipRecord,
  MembershipRepository,
  MembershipWithUser,
  OrganizationRecord,
  OrganizationRepository,
  SiteRecord,
  SiteRepository,
  SiteSettingsRecord,
  SiteSettingsRepository,
  TenantRepositories,
  UpdateClientInput,
  UpdateOrganizationInput,
  UpdateSiteInput,
  UpdateSiteSettingsInput,
} from './repositories/index.js';

/**
 * Authorization. The policy lives in `@organic-os/authorization`; these are the two
 * pieces that need a database: the membership bootstrap that proves membership before
 * any tenant context exists, and the canonical authorized tenant transaction.
 */
export { createMembershipStore } from './authorization/membership-store.js';

export {
  createAuthorizationService,
  type AuthorizationService,
  type AuthorizationServiceOptions,
  type AuthorizedOrganizationSession,
} from './authorization/with-authorized-organization.js';

/**
 * Member administration (Phase 0.4.2A). The policy it enforces lives in
 * `@organic-os/authorization`; what is here is the transaction that locks the rows,
 * writes the change, revokes the affected sessions and appends the audit record —
 * all of it as one commit (ADR-0017).
 */
export {
  createMemberAdministrationService,
  type AddMemberInput,
  type AdministrationRequest,
  type ChangeMemberRoleInput,
  type ClientAccessRequest,
  type MemberAdministrationService,
  type MemberAdministrationServiceOptions,
  type MemberView,
  type RemoveMemberInput,
  type ReplaceMemberScopesInput,
} from './administration/membership-administration.js';

export type {
  AuditActorKind,
  AuditResult,
  AuditSource,
  AutopilotMode,
  ClientAccessMode,
  ClientStatus,
  IntegrationStatus,
  IntegrationTokenKind,
  MembershipRole,
  SiteStatus,
} from './schema/enums.js';

/** Privileged tenant provisioning. Requires the provisioning role, not the runtime role. */
export {
  findOrganizationBySlug,
  isProvisioningError,
  provisionFirstOrganization,
  provisionMembership,
  provisionOrganization,
  provisionUser,
  ProvisioningError,
  type FirstAdministratorInput,
  type ProvisionFirstOrganizationInput,
  type ProvisionFirstOrganizationResult,
  type ProvisioningFailure,
  type ProvisionMembershipInput,
  type ProvisionOrganizationInput,
  type ProvisionUserInput,
  type UserRecord,
} from './provisioning.js';

export {
  DEFAULT_GRADUATION_POLICY,
  DEFAULT_INGESTION_LIMITS,
  DEFAULT_RETENTION,
  graduationPolicySchema,
  ingestionOverridesSchema,
  InvalidSettingsError,
  parseGraduationPolicy,
  parseIngestionOverrides,
  parseRetentionOverrides,
  resolveGraduationPolicy,
  retentionOverridesSchema,
  type GraduationPolicyInput,
  type IngestionOverridesInput,
  type ResolvedGraduationPolicy,
  type RetentionOverridesInput,
} from './settings/schemas.js';

export { bootstrapDatabase, ROLE_NAMES, type BootstrapOptions, type RoleKey } from './bootstrap.js';

export {
  checksumOf,
  loadMigrationFiles,
  migrate,
  migrationStatus,
  MigrationError,
  MIGRATIONS_DIRECTORY,
  type MigrateResult,
  type MigrationFile,
  type MigrationStatusEntry,
} from './migrations/runner.js';

export {
  describeConnection,
  DatabaseConfigError,
  isLocalConnection,
  parseDatabaseEnv,
  runtimeDatabaseEnvSchema,
  type RuntimeDatabaseEnv,
} from './config.js';

/**
 * Transport security. A connection that leaves this machine is opened with verified
 * TLS or not at all; see `src/tls.ts` for why `sslmode=require` is not the answer.
 */
export { DatabaseTlsError, SSL_ROOT_CERT_VARIABLE, tlsOptionsFor } from './tls.js';

/**
 * Managed-environment verification (Cloud Foundation 0.1). Read-only and
 * rolled-back checks that the platform really provides the privileges, extensions and
 * transaction semantics the architecture assumes. Never a substitute for the
 * disposable CI suite (docs/cloud/SUPABASE-STAGING.md).
 */
export {
  StagingTargetError,
  verifyStagingEnvironment,
  type CheckStatus,
  type StagingCheck,
  type StagingVerificationInput,
  type StagingVerificationResult,
} from './staging/verify.js';

export { checkDatabaseReady } from './readiness.js';

export { newId } from './ids.js';

/**
 * Authentication persistence. Implements the `AuthStore` port from
 * `@organic-os/auth`; the security policy it serves lives there, not here.
 */
export { createAuthStore } from './auth/store.js';
