import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { inet, type JsonObject } from './columns.js';
import type { AuditActorKind, AuditResult, AuditSource } from './enums.js';

/** Global platform configuration — not tenant data, so no RLS (migration 0002). */
export const featureFlags = pgTable('feature_flags', {
  id: uuid('id').primaryKey(),
  key: text('key').notNull(),
  description: text('description').notNull(),
  defaultEnabled: boolean('default_enabled').notNull().default(false),
  overrides: jsonb('overrides').$type<JsonObject>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Append-only audit trail. `organizationId` carries no foreign key on purpose: audit
 * records outlive the tenant they describe. The runtime role holds only SELECT and
 * INSERT, so history cannot be rewritten by the application.
 */
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  actorKind: text('actor_kind').$type<AuditActorKind>().notNull(),
  actorId: text('actor_id'),
  /**
   * The membership the actor acted through (migration 0005). Null for workers, for
   * system actors, and for any writer that holds no membership. Not derivable after
   * the fact: a membership can be removed and re-created for the same pair.
   */
  actorMembershipId: uuid('actor_membership_id'),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id'),
  before: jsonb('before').$type<JsonObject>(),
  after: jsonb('after').$type<JsonObject>(),
  source: text('source').$type<AuditSource>().notNull(),
  ip: inet('ip'),
  result: text('result').$type<AuditResult>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
