import { z } from 'zod';

/**
 * Typed shapes for the JSONB settings columns.
 *
 * Stored objects are *overrides*: an absent key means "inherit the platform default"
 * declared below. Nothing here is hardcoded into the database, and unknown keys are
 * rejected so a settings column cannot silently accumulate junk (task §16).
 */

// --- Safety graduation policy (docs/EXECUTION-SAFETY.md §3.1) -----------------

export const graduationPolicySchema = z.strictObject({
  minGreenActions: z.number().int().min(0).max(100_000).optional(),
  requireAllQaPassed: z.boolean().optional(),
  maxCriticalIncidents: z.number().int().min(0).max(1_000).optional(),
  maxUnresolvedRollbackFailures: z.number().int().min(0).max(1_000).optional(),
  requireExplicitOptIn: z.boolean().optional(),
});

export type GraduationPolicyInput = z.infer<typeof graduationPolicySchema>;

/** Recommended baseline. Configurable per organization and per site — never a rule. */
export const DEFAULT_GRADUATION_POLICY = {
  minGreenActions: 20,
  requireAllQaPassed: true,
  maxCriticalIncidents: 0,
  maxUnresolvedRollbackFailures: 0,
  requireExplicitOptIn: true,
} as const;

// --- Ingestion and quota controls (docs/ARCHITECTURE.md §7.1) -----------------

export const ingestionOverridesSchema = z.strictObject({
  maxCrawlUrlsPerRun: z.number().int().min(1).max(10_000_000).optional(),
  maxCrawlDepth: z.number().int().min(1).max(100).optional(),
  crawlConcurrencyPerHost: z.number().int().min(1).max(64).optional(),
  crawlConcurrencyPerSite: z.number().int().min(1).max(256).optional(),
  crawlRequestsPerSecond: z.number().min(0.1).max(100).optional(),
  maxKeywordImportRows: z.number().int().min(1).max(5_000_000).optional(),
  gscMaxRowsPerDay: z.number().int().min(1).max(10_000_000).optional(),
});

export type IngestionOverridesInput = z.infer<typeof ingestionOverridesSchema>;

export const DEFAULT_INGESTION_LIMITS = {
  maxCrawlUrlsPerRun: 10_000,
  maxCrawlDepth: 10,
  crawlConcurrencyPerHost: 2,
  crawlConcurrencyPerSite: 4,
  crawlRequestsPerSecond: 2,
  maxKeywordImportRows: 50_000,
  gscMaxRowsPerDay: 50_000,
} as const;

// --- Retention (docs/DATA-MODEL.md §12, PRD §192) -----------------------------

export const retentionOverridesSchema = z.strictObject({
  crawlPagesDays: z.number().int().min(1).max(3_650).optional(),
  screenshotsMonths: z.number().int().min(1).max(120).optional(),
  snapshotsMonths: z.number().int().min(1).max(120).optional(),
  serpSnapshotsMonths: z.number().int().min(1).max(120).optional(),
  llmCallsMonths: z.number().int().min(1).max(120).optional(),
  llmDebugCaptureDays: z.number().int().min(1).max(365).optional(),
  applicationLogsDays: z.number().int().min(1).max(3_650).optional(),
});

export type RetentionOverridesInput = z.infer<typeof retentionOverridesSchema>;

export const DEFAULT_RETENTION = {
  crawlPagesDays: 90,
  screenshotsMonths: 12,
  snapshotsMonths: 12,
  serpSnapshotsMonths: 6,
  llmCallsMonths: 13,
  llmDebugCaptureDays: 30,
  applicationLogsDays: 30,
} as const;

// --- Parsing ------------------------------------------------------------------

export class InvalidSettingsError extends Error {
  readonly issues: readonly string[];

  constructor(setting: string, issues: readonly string[]) {
    super(`Invalid ${setting}: ${issues.join(', ')}`);
    this.name = 'InvalidSettingsError';
    this.issues = issues;
  }
}

function parseSetting<T extends z.ZodType>(schema: T, name: string, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new InvalidSettingsError(
      name,
      result.error.issues.map(
        (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.code}`,
      ),
    );
  }

  return result.data;
}

export function parseGraduationPolicy(value: unknown): GraduationPolicyInput {
  return parseSetting(graduationPolicySchema, 'graduationPolicy', value);
}

export function parseIngestionOverrides(value: unknown): IngestionOverridesInput {
  return parseSetting(ingestionOverridesSchema, 'ingestionOverrides', value);
}

export function parseRetentionOverrides(value: unknown): RetentionOverridesInput {
  return parseSetting(retentionOverridesSchema, 'retentionOverrides', value);
}

export interface ResolvedGraduationPolicy {
  minGreenActions: number;
  requireAllQaPassed: boolean;
  maxCriticalIncidents: number;
  maxUnresolvedRollbackFailures: number;
  requireExplicitOptIn: boolean;
}

/**
 * Effective policy: the platform baseline with a site's overrides applied.
 *
 * Each field is resolved individually rather than by spreading, so an override that
 * is present but undefined cannot erase a default.
 */
export function resolveGraduationPolicy(overrides: unknown): ResolvedGraduationPolicy {
  const parsed = parseGraduationPolicy(overrides ?? {});

  return {
    minGreenActions: parsed.minGreenActions ?? DEFAULT_GRADUATION_POLICY.minGreenActions,
    requireAllQaPassed: parsed.requireAllQaPassed ?? DEFAULT_GRADUATION_POLICY.requireAllQaPassed,
    maxCriticalIncidents:
      parsed.maxCriticalIncidents ?? DEFAULT_GRADUATION_POLICY.maxCriticalIncidents,
    maxUnresolvedRollbackFailures:
      parsed.maxUnresolvedRollbackFailures ??
      DEFAULT_GRADUATION_POLICY.maxUnresolvedRollbackFailures,
    requireExplicitOptIn:
      parsed.requireExplicitOptIn ?? DEFAULT_GRADUATION_POLICY.requireExplicitOptIn,
  };
}
