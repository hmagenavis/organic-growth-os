import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { bytea, type JsonObject } from './columns.js';
import { integrationStatusEnum, integrationTokenKindEnum } from './enums.js';

/**
 * Persistence shell only — no provider is connected in this phase (ADR-0010, ADR-0011).
 */
export const integrations = pgTable('integrations', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  clientId: uuid('client_id'),
  siteId: uuid('site_id'),
  provider: text('provider').notNull(),
  status: integrationStatusEnum('status').notNull().default('connected'),
  /** Non-secret provider configuration. Credentials never live here. */
  config: jsonb('config').$type<JsonObject>().notNull().default({}),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  errorDetail: text('error_detail'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Envelope-encrypted credential storage. There is no plaintext column by design.
 * The encryption implementation itself belongs to sub-phase 0.6 (docs/SECURITY.md §5);
 * this phase provides only the table, and nothing writes to it yet.
 */
export const integrationTokens = pgTable('integration_tokens', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  integrationId: uuid('integration_id').notNull(),
  tokenKind: integrationTokenKindEnum('token_kind').notNull(),
  ciphertext: bytea('ciphertext').notNull(),
  keyVersion: integer('key_version').notNull(),
  algo: text('algo').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
