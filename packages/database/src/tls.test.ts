import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DatabaseTlsError, SSL_ROOT_CERT_VARIABLE, tlsOptionsFor } from './tls.js';

const LOCAL_URL = 'postgres://organic_os_runtime:pw@127.0.0.1:5432/organic_os';
const REMOTE_URL =
  'postgres://organic_os_runtime.ref:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres';

/** Not a real certificate; only the PEM framing matters to this module. */
const PEM = ['-----BEGIN CERTIFICATE-----', 'MIIBfake', '-----END CERTIFICATE-----', ''].join('\n');

function certificateFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'organic-os-tls-')), 'root.crt');
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('tlsOptionsFor', () => {
  it('asks for no TLS on a loopback connection', () => {
    expect(tlsOptionsFor(LOCAL_URL, {})).toBeUndefined();
    expect(tlsOptionsFor('postgres://u:p@localhost:5432/db', {})).toBeUndefined();
  });

  it('refuses a connection that leaves the machine with no configured root', () => {
    expect(() => tlsOptionsFor(REMOTE_URL, {})).toThrow(DatabaseTlsError);
    expect(() => tlsOptionsFor(REMOTE_URL, { [SSL_ROOT_CERT_VARIABLE]: '   ' })).toThrow(
      DatabaseTlsError,
    );
  });

  it('names the variable and the host, and never the credential, when it refuses', () => {
    try {
      tlsOptionsFor(REMOTE_URL, {});
      expect.unreachable('a remote connection without a root certificate must be refused');
    } catch (error: unknown) {
      const message = (error as Error).message;

      expect(message).toContain(SSL_ROOT_CERT_VARIABLE);
      expect(message).toContain('aws-0-eu-central-1.pooler.supabase.com');
      expect(message).not.toContain('pw');
      expect(message).not.toContain('organic_os_runtime');
    }
  });

  it('demands verify-full, not merely encryption, for a remote connection', () => {
    const options = tlsOptionsFor(REMOTE_URL, {
      [SSL_ROOT_CERT_VARIABLE]: certificateFile(PEM),
    });

    expect(options?.ca).toContain('BEGIN CERTIFICATE');
    // rejectUnauthorized alone is verify-ca; the servername is what makes it verify-full.
    expect(options?.rejectUnauthorized).toBe(true);
    expect(options?.servername).toBe('aws-0-eu-central-1.pooler.supabase.com');
    expect(options?.minVersion).toBe('TLSv1.2');
  });

  it('accepts the certificate inline, for platforms whose only surface is env vars', () => {
    expect(tlsOptionsFor(REMOTE_URL, { [SSL_ROOT_CERT_VARIABLE]: PEM })?.ca).toBe(PEM);
  });

  it('refuses a path that does not exist or holds no certificate', () => {
    expect(() =>
      tlsOptionsFor(REMOTE_URL, { [SSL_ROOT_CERT_VARIABLE]: join(tmpdir(), 'no-such-root.crt') }),
    ).toThrow(DatabaseTlsError);

    expect(() =>
      tlsOptionsFor(REMOTE_URL, { [SSL_ROOT_CERT_VARIABLE]: certificateFile('not a certificate') }),
    ).toThrow(DatabaseTlsError);
  });
});
