import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';

import { describeConnection, isLocalConnection } from './config.js';

/**
 * Transport security for database connections.
 *
 * The gap this closes is specific and was found live, not assumed: `pg` negotiates no
 * TLS at all unless it is given SSL options, and a managed Postgres (Supabase
 * included) accepts unencrypted connections by default "to maximise client
 * compatibility". A connection string alone therefore says nothing about whether
 * anything crossing that socket is encrypted.
 *
 * Be precise about what that does and does not expose, because the distinction decides
 * how urgent this is. Authentication is `scram-sha-256`, verified on the live project,
 * so the password is a challenge-response and is **not** recoverable from the wire even
 * with no TLS. What an unencrypted connection does expose is everything after
 * authentication — every query, every tenant row, every session token that is read or
 * written — to a passive observer, and the whole session to an active
 * man-in-the-middle, since nothing authenticates the server. SCRAM protects the
 * credential; it protects no data. Against a local Docker server on the loopback
 * interface none of this matters. Against a managed database reached over the public
 * internet all of it does.
 *
 * So the rule is a property of the code rather than of whoever typed the connection
 * string: **a non-local connection is opened with verified TLS or it is not opened.**
 *
 * `sslmode=require` is deliberately not the answer. It encrypts without authenticating
 * the server, which stops passive snooping and does nothing about an active
 * man-in-the-middle — and it is what most "add SSL" advice reaches for. This module
 * implements `verify-full`: the chain must terminate in the configured root, and the
 * hostname must match the certificate.
 *
 * `DATABASE_SSL_ROOT_CERT` holds the root, as either an absolute path to a PEM file or
 * the PEM text itself (a file is the norm; inline suits a platform whose only
 * configuration surface is environment variables). It is not a secret — a root CA is
 * public — so it belongs in variables, never in secrets.
 *
 * Absence fails closed, per the handling rules in docs/cloud/ENVIRONMENT-MATRIX.md §9:
 * an unset variable refuses the connection rather than silently downgrading it to
 * plaintext, which is the failure this module exists to make impossible.
 */

export const SSL_ROOT_CERT_VARIABLE = 'DATABASE_SSL_ROOT_CERT';

const PEM_PREFIX = '-----BEGIN CERTIFICATE-----';

export class DatabaseTlsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseTlsError';
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;

function readRootCertificate(value: string): string {
  if (value.trimStart().startsWith(PEM_PREFIX)) {
    return value;
  }

  const path = value.trim();
  let contents: string;

  try {
    contents = readFileSync(path, 'utf8');
  } catch (error: unknown) {
    // The path is configuration, not a credential, so naming it is safe and is the
    // only way an operator can tell a typo from a missing file.
    throw new DatabaseTlsError(
      `${SSL_ROOT_CERT_VARIABLE} points at ${path}, which could not be read`,
      { cause: error },
    );
  }

  if (!contents.includes(PEM_PREFIX)) {
    throw new DatabaseTlsError(
      `${SSL_ROOT_CERT_VARIABLE} points at ${path}, which contains no PEM certificate`,
    );
  }

  return contents;
}

/**
 * TLS options for a connection, or `undefined` when the target is the developer's own
 * machine and TLS would only be ceremony.
 *
 * @throws {DatabaseTlsError} when the connection leaves this machine and no root
 * certificate is configured.
 */
export function tlsOptionsFor(
  url: string,
  env: EnvSource = process.env,
): ConnectionOptions | undefined {
  if (isLocalConnection(url)) {
    return undefined;
  }

  // Trimmed only to decide emptiness and to tolerate a path with stray whitespace;
  // an inline certificate is passed through verbatim, trailing newline included.
  const configured = env[SSL_ROOT_CERT_VARIABLE];
  const { host } = describeConnection(url);

  if (configured === undefined || configured.trim() === '') {
    throw new DatabaseTlsError(
      `Refusing to open an unverified connection to ${host}: ${SSL_ROOT_CERT_VARIABLE} is not ` +
        'set. A connection that leaves this machine must present a certificate chaining to a ' +
        'configured root (docs/cloud/SUPABASE-STAGING.md §3).',
    );
  }

  return {
    ca: readRootCertificate(configured),
    // Together these are `verify-full`: the chain must be trusted AND the hostname must
    // match. `rejectUnauthorized` alone would leave the certificate valid-for-anything.
    rejectUnauthorized: true,
    servername: host,
    minVersion: 'TLSv1.2',
  };
}
