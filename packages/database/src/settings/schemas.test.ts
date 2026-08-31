import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GRADUATION_POLICY,
  InvalidSettingsError,
  parseGraduationPolicy,
  parseIngestionOverrides,
  parseRetentionOverrides,
  resolveGraduationPolicy,
} from './schemas.js';

describe('graduation policy', () => {
  it('treats an empty object as full inheritance', () => {
    expect(parseGraduationPolicy({})).toEqual({});
  });

  it('accepts a partial override', () => {
    expect(parseGraduationPolicy({ minGreenActions: 50 })).toEqual({ minGreenActions: 50 });
  });

  it('rejects unknown keys so settings cannot accumulate junk', () => {
    expect(() => parseGraduationPolicy({ minGreenActions: 5, autoApprove: true })).toThrow(
      InvalidSettingsError,
    );
  });

  it('rejects malformed values', () => {
    expect(() => parseGraduationPolicy({ minGreenActions: -1 })).toThrow(InvalidSettingsError);
    expect(() => parseGraduationPolicy({ requireExplicitOptIn: 'yes' })).toThrow(
      InvalidSettingsError,
    );
  });

  it('resolves the recommended baseline when nothing is overridden', () => {
    expect(resolveGraduationPolicy({})).toEqual(DEFAULT_GRADUATION_POLICY);
    expect(resolveGraduationPolicy(null)).toEqual(DEFAULT_GRADUATION_POLICY);
  });

  it('lets a site override the baseline rather than treating it as a rule', () => {
    const resolved = resolveGraduationPolicy({ minGreenActions: 5, requireExplicitOptIn: true });

    expect(resolved.minGreenActions).toBe(5);
    expect(resolved.requireAllQaPassed).toBe(DEFAULT_GRADUATION_POLICY.requireAllQaPassed);
  });

  it('keeps explicit opt-in and zero-incident defaults', () => {
    expect(DEFAULT_GRADUATION_POLICY.requireExplicitOptIn).toBe(true);
    expect(DEFAULT_GRADUATION_POLICY.maxCriticalIncidents).toBe(0);
    expect(DEFAULT_GRADUATION_POLICY.maxUnresolvedRollbackFailures).toBe(0);
  });
});

describe('ingestion overrides', () => {
  it('accepts documented limits', () => {
    expect(parseIngestionOverrides({ maxCrawlUrlsPerRun: 500, maxCrawlDepth: 3 })).toEqual({
      maxCrawlUrlsPerRun: 500,
      maxCrawlDepth: 3,
    });
  });

  it('rejects unknown or out-of-range limits', () => {
    expect(() => parseIngestionOverrides({ maxCrawlUrls: 500 })).toThrow(InvalidSettingsError);
    expect(() => parseIngestionOverrides({ maxCrawlDepth: 0 })).toThrow(InvalidSettingsError);
  });
});

describe('retention overrides', () => {
  it('accepts documented windows', () => {
    expect(parseRetentionOverrides({ crawlPagesDays: 30 })).toEqual({ crawlPagesDays: 30 });
  });

  it('rejects unknown or non-positive windows', () => {
    expect(() => parseRetentionOverrides({ auditLogsYears: 7 })).toThrow(InvalidSettingsError);
    expect(() => parseRetentionOverrides({ crawlPagesDays: 0 })).toThrow(InvalidSettingsError);
  });
});
