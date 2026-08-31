import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import type { JsonObject } from './columns.js';
import { autopilotModeEnum } from './enums.js';

export const clients = pgTable('clients', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  name: text('name').notNull(),
  status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
  industry: text('industry'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sites = pgTable('sites', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  clientId: uuid('client_id').notNull(),
  baseUrl: text('base_url').notNull(),
  cmsType: text('cms_type').$type<'wordpress'>().notNull().default('wordpress'),
  status: text('status').$type<'active' | 'paused' | 'archived'>().notNull().default('active'),
  timezone: text('timezone').notNull().default('UTC'),
  language: text('language').notNull().default('en'),
  crawlBudget: jsonb('crawl_budget').$type<JsonObject>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-site policy configuration. Empty JSON means "inherit the platform default":
 * thresholds live in typed application schemas (`src/settings`), never hardcoded in
 * the database.
 */
export const siteSettings = pgTable('site_settings', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  siteId: uuid('site_id').notNull(),
  autopilotMode: autopilotModeEnum('autopilot_mode').notNull().default('review'),
  graduationPolicy: jsonb('graduation_policy').$type<JsonObject>().notNull().default({}),
  graduatedAt: timestamp('graduated_at', { withTimezone: true }),
  graduationApprovedBy: uuid('graduation_approved_by'),
  riskOverrides: jsonb('risk_overrides').$type<JsonObject>().notNull().default({}),
  modelRouterOverrides: jsonb('model_router_overrides').$type<JsonObject>().notNull().default({}),
  ingestionOverrides: jsonb('ingestion_overrides').$type<JsonObject>().notNull().default({}),
  crawlSchedule: jsonb('crawl_schedule').$type<JsonObject>().notNull().default({}),
  retentionOverrides: jsonb('retention_overrides').$type<JsonObject>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
