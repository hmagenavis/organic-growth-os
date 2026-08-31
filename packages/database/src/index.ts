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

export type {
  AuditActorKind,
  AuditResult,
  AuditSource,
  AutopilotMode,
  ClientStatus,
  IntegrationStatus,
  IntegrationTokenKind,
  MembershipRole,
  SiteStatus,
} from './schema/enums.js';

/** Privileged tenant provisioning. Requires the provisioning role, not the runtime role. */
export {
  findOrganizationBySlug,
  provisionMembership,
  provisionOrganization,
  provisionUser,
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

export { newId } from './ids.js';
