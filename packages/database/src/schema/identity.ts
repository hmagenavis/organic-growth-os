import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { bytea, citext, inet, type JsonObject } from './columns.js';
import { membershipRoleEnum } from './enums.js';

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  slug: citext('slug').notNull(),
  settings: jsonb('settings').$type<JsonObject>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: citext('email').notNull(),
  /** Written by the authentication sub-phase (0.3); no credential exists yet. */
  passwordHash: text('password_hash'),
  name: text('name').notNull(),
  locale: text('locale').notNull().default('en'),
  /** Platform-level, never grantable through organization administration. */
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable('memberships', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  userId: uuid('user_id').notNull(),
  role: membershipRoleEnum('role').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Restricts a membership to specific clients. The database pins both sides to this
 * row's organization through composite foreign keys, so a cross-organization scope
 * cannot be written even by a caller that tries (migration 0001).
 */
export const membershipClientScopes = pgTable('membership_client_scopes', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  membershipId: uuid('membership_id').notNull(),
  clientId: uuid('client_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Not tenant-scoped: resolved by token hash before any organization is known. */
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
