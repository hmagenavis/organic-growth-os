import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Organization roles. Platform administration is deliberately absent: it is not an
 * organization role and lives on `users.is_platform_admin` (docs/SECURITY.md §3).
 */
export const membershipRoleEnum = pgEnum('membership_role', [
  'agency_admin',
  'seo_manager',
  'content_editor',
  'analyst',
  'client_viewer',
]);

/**
 * Whether a membership reaches every client of its organization or only the clients
 * listed in `membership_client_scopes`. Stated explicitly on the membership so an
 * empty scope collection can never be read as "all" (migration 0004,
 * docs/SECURITY.md §3).
 */
export const clientAccessModeEnum = pgEnum('client_access_mode', ['all_clients', 'scoped']);

export const autopilotModeEnum = pgEnum('autopilot_mode', [
  'off',
  'review',
  'safe_autopilot',
  'full_autopilot',
]);

export const integrationStatusEnum = pgEnum('integration_status', [
  'connected',
  'error',
  'revoked',
  'expired',
]);

export const integrationTokenKindEnum = pgEnum('integration_token_kind', [
  'oauth_refresh',
  'oauth_access',
  'app_password',
  'api_key',
]);

export type MembershipRole = (typeof membershipRoleEnum.enumValues)[number];
export type ClientAccessMode = (typeof clientAccessModeEnum.enumValues)[number];
export type AutopilotMode = (typeof autopilotModeEnum.enumValues)[number];
export type IntegrationStatus = (typeof integrationStatusEnum.enumValues)[number];
export type IntegrationTokenKind = (typeof integrationTokenKindEnum.enumValues)[number];

export const CLIENT_STATUSES = ['active', 'archived'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const SITE_STATUSES = ['active', 'paused', 'archived'] as const;
export type SiteStatus = (typeof SITE_STATUSES)[number];

export const AUDIT_ACTOR_KINDS = ['user', 'system', 'worker'] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

export const AUDIT_SOURCES = ['ui', 'api', 'worker', 'wp_plugin', 'migration'] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

export const AUDIT_RESULTS = ['ok', 'denied', 'error'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];
