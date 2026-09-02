import { describe, expect, it } from 'vitest';

import {
  isSiteInputError,
  normalizeBaseUrl,
  normalizeLanguage,
  normalizeTimezone,
  SiteInputError,
} from './normalize.js';

/**
 * The one part of the site API that is pure, and therefore the one part that can be
 * proven exhaustively without a database. What it protects is the meaning of
 * `UNIQUE (organization_id, base_url)`: two spellings of one site must normalize to
 * one row, and a value this function returns must never be one the CHECK constraint
 * in migration 0001 would reject.
 */

function reasonFor(run: () => unknown): string {
  try {
    run();
  } catch (error: unknown) {
    if (isSiteInputError(error)) {
      return error.reason;
    }

    throw error;
  }

  return '(accepted)';
}

describe('normalizeBaseUrl', () => {
  it.each([
    ['https://example.test', 'https://example.test'],
    ['  https://example.test  ', 'https://example.test'],
    ['https://example.test/', 'https://example.test'],
    ['https://example.test///', 'https://example.test'],
    ['HTTPS://EXAMPLE.TEST', 'https://example.test'],
    ['https://example.test.', 'https://example.test'],
    ['http://example.test', 'http://example.test'],
    ['https://example.test:443', 'https://example.test'],
    ['http://example.test:80/', 'http://example.test'],
    ['https://example.test:8443', 'https://example.test:8443'],
    ['https://example.test/blog/', 'https://example.test/blog'],
    ['https://example.test/Blog/Posts', 'https://example.test/Blog/Posts'],
    ['https://sub.example.test', 'https://sub.example.test'],
    ['https://xn--4dbrk0ce.test', 'https://xn--4dbrk0ce.test'],
    ['https://ישראל.test', 'https://xn--4dbrk0ce.test'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });

  it('keeps path case because a path is case-sensitive', () => {
    expect(normalizeBaseUrl('https://EXAMPLE.test/Case')).toBe('https://example.test/Case');
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['example.test', 'unparseable'],
    ['/relative/path', 'unparseable'],
    ['not a url', 'unparseable'],
    ['ftp://example.test', 'unsupported_scheme'],
    ['javascript:alert(1)', 'unsupported_scheme'],
    ['file:///etc/passwd', 'unsupported_scheme'],
    ['https://user:secret@example.test', 'credentials_present'],
    ['https://example.test?utm_source=x', 'query_present'],
    ['https://example.test/#section', 'fragment_present'],
    ['https://.', 'missing_host'],
  ])('refuses %s as %s', (input, reason) => {
    expect(reasonFor(() => normalizeBaseUrl(input))).toBe(reason);
  });

  it('refuses a URL longer than the stored bound', () => {
    const long = `https://example.test/${'a'.repeat(2100)}`;
    expect(reasonFor(() => normalizeBaseUrl(long))).toBe('too_long');
  });

  it('never produces a value the database CHECK constraint would reject', () => {
    for (const input of [
      'https://example.test',
      'http://example.test:8080/deep/path/',
      'https://ישראל.test/עמוד',
    ]) {
      expect(normalizeBaseUrl(input)).toMatch(/^https?:\/\/\S+$/);
    }
  });

  it('is idempotent', () => {
    for (const input of ['https://example.test/', 'HTTP://Example.Test:80/blog/']) {
      const once = normalizeBaseUrl(input);
      expect(normalizeBaseUrl(once)).toBe(once);
    }
  });

  it('reports the field it refused', () => {
    try {
      normalizeBaseUrl('ftp://example.test');
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(SiteInputError);
      expect(isSiteInputError(error) ? error.field : null).toBe('baseUrl');
    }
  });

  it('does not echo the rejected value in its message', () => {
    try {
      normalizeBaseUrl('https://user:hunter2@example.test');
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(error instanceof Error ? error.message : '').not.toContain('hunter2');
    }
  });
});

describe('normalizeTimezone', () => {
  it.each([
    ['UTC', 'UTC'],
    ['  UTC  ', 'UTC'],
    ['Asia/Jerusalem', 'Asia/Jerusalem'],
    ['Europe/London', 'Europe/London'],
    ['America/New_York', 'America/New_York'],
  ])('accepts %s as %s', (input, expected) => {
    expect(normalizeTimezone(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['Mars/Olympus', 'unknown_timezone'],
    ['not a zone', 'unknown_timezone'],
    ['+02:00', 'offset_timezone_not_supported'],
    ['-05:00', 'offset_timezone_not_supported'],
  ])('refuses %s as %s', (input, reason) => {
    expect(reasonFor(() => normalizeTimezone(input))).toBe(reason);
  });

  it('refuses a value longer than the stored bound', () => {
    expect(reasonFor(() => normalizeTimezone('A'.repeat(80)))).toBe('too_long');
  });
});

describe('normalizeLanguage', () => {
  it.each([
    ['en', 'en'],
    ['EN', 'en'],
    ['en-us', 'en-US'],
    ['he', 'he'],
    ['pt-br', 'pt-BR'],
  ])('canonicalizes %s to %s', (input, expected) => {
    expect(normalizeLanguage(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['english please', 'malformed_language_tag'],
    ['e', 'malformed_language_tag'],
    ['--', 'malformed_language_tag'],
  ])('refuses %s as %s', (input, reason) => {
    expect(reasonFor(() => normalizeLanguage(input))).toBe(reason);
  });

  it('refuses a value longer than the stored bound', () => {
    expect(reasonFor(() => normalizeLanguage('en-'.repeat(20)))).toBe('too_long');
  });
});
