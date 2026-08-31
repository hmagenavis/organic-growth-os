import { parseArgs } from 'node:util';

import {
  checkPasswordPolicy,
  createPasswordHasher,
  DEFAULT_PASSWORD_HASH_PARAMETERS,
} from '@organic-os/auth';

import { createDatabase } from '../client.js';
import { describeConnection, parseDatabaseEnv, provisionerDatabaseEnvSchema } from '../config.js';
import {
  isProvisioningError,
  provisionFirstOrganization,
  type FirstAdministratorInput,
} from '../provisioning.js';
import { createCliLogger, reportFailure } from './shared.js';
import { readSecretFromTty } from './secret-prompt.js';

/**
 * `pnpm provision:organization` — the entire organization-creation surface of Phase 0.
 *
 * There is no HTTP endpoint behind this, no public sign-up, and no platform-admin
 * route group. That is deliberate: creating a tenant requires the
 * `organic_os_provisioner` credential, and the one process that serves requests
 * never opens a connection with it (§13 of the sub-phase brief, docs/SECURITY.md §5).
 * An operator command line is the smallest boundary that can hold that credential
 * without exposing it to anything a browser can reach.
 *
 *   pnpm provision:organization --name "Acme Agency" --slug acme --email ada@acme.test
 *
 * The address may name an account that already exists, which is the preferred path.
 * When it does not, and the terminal is interactive, the command offers to create the
 * account and **prompts for the password with the echo turned off**. The password is
 * never an argument: argv is visible in shell history, in `ps` output and in process
 * listings, and a first-administrator credential is exactly the value that must not
 * be in any of them (§14 of the sub-phase brief). It is hashed here with Argon2id and
 * only the hash is passed on.
 *
 * Retrying after a timeout is safe. Provisioning is idempotent on the slug: the
 * second run reports the same identifiers and creates nothing.
 *
 * Nothing secret is printed. The output is three identifiers and a created/existing
 * flag.
 */

const logger = createCliLogger('provision:organization');

interface Options {
  readonly name: string;
  readonly slug: string;
  readonly email: string;
  /** Refuses the interactive account-creation path; fails instead. */
  readonly existingUserOnly: boolean;
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm provision:organization --name <display name> --slug <url-slug> --email <address>',
    '',
    'Options:',
    '  --name              Organization display name (1-200 characters).',
    '  --slug              Unique URL slug, [a-z0-9-], 2-63 characters. Also the',
    '                      idempotency key: rerunning with the same slug creates nothing.',
    '  --email             Address of the first agency_admin.',
    '  --existing-user     Fail if no account exists for the address, instead of',
    '                      offering to create one interactively.',
    '',
    'Environment:',
    '  DATABASE_PROVISIONER_URL   Connection using organic_os_provisioner.',
  ].join('\n');
}

function readOptions(argv: readonly string[]): Options {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      name: { type: 'string' },
      slug: { type: 'string' },
      email: { type: 'string' },
      'existing-user': { type: 'boolean', default: false },
    },
    strict: true,
  });

  const missing = (['name', 'slug', 'email'] as const).filter(
    (key) => values[key] === undefined || values[key] === '',
  );

  if (missing.length > 0) {
    throw new Error(`Missing required option(s): ${missing.join(', ')}\n\n${usage()}`);
  }

  return {
    name: values.name ?? '',
    slug: values.slug ?? '',
    email: values.email ?? '',
    existingUserOnly: values['existing-user'] ?? false,
  };
}

/**
 * Collects the first administrator's account details interactively.
 *
 * Only reached when no account exists for the address and the command is attached to
 * a terminal. The password is read twice with the echo off, compared, and checked
 * against the platform policy before anything is written.
 */
async function promptForNewAdministrator(email: string): Promise<FirstAdministratorInput> {
  const name = (await readSecretFromTty(`Full name for ${email}: `, { echo: true })).trim();

  if (name === '') {
    throw new Error('A name is required for a new account');
  }

  const password = await readSecretFromTty('Password (not echoed): ', { echo: false });
  const confirmation = await readSecretFromTty('Repeat password: ', { echo: false });

  if (password !== confirmation) {
    throw new Error('The two passwords do not match');
  }

  const policy = checkPasswordPolicy(password);

  if (!policy.ok) {
    throw new Error(`Password rejected: ${policy.issues.join('; ')}`);
  }

  // The production Argon2id baseline, not a runtime override: an encoded Argon2 hash
  // carries its own parameters, so verification at login works regardless of what the
  // API is configured with, and provisioning must never produce a weaker one.
  const hasher = createPasswordHasher(DEFAULT_PASSWORD_HASH_PARAMETERS);

  return { kind: 'new_user', email, name, passwordHash: await hasher.hash(password) };
}

async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2));
  const env = parseDatabaseEnv(provisionerDatabaseEnvSchema);

  logger.info(
    { ...describeConnection(env.DATABASE_PROVISIONER_URL), slug: options.slug },
    'provisioning organization',
  );

  const database = createDatabase({
    connectionString: env.DATABASE_PROVISIONER_URL,
    maxConnections: 1,
    applicationName: 'organic-os-provisioning',
  });

  try {
    const attach = async (
      admin: FirstAdministratorInput,
    ): Promise<Awaited<ReturnType<typeof provisionFirstOrganization>>> =>
      provisionFirstOrganization(database.db, {
        organization: { name: options.name, slug: options.slug },
        admin,
      });

    let result: Awaited<ReturnType<typeof provisionFirstOrganization>>;

    try {
      result = await attach({ kind: 'existing_user', email: options.email });
    } catch (error: unknown) {
      const noAccount = isProvisioningError(error) && error.failure === 'user_not_registered';

      if (!noAccount || options.existingUserOnly) {
        throw error;
      }

      if (!process.stdin.isTTY) {
        throw new Error(
          `No account exists for ${options.email}. Rerun this command from an interactive ` +
            'terminal to create one, or provision the account first. A password is never ' +
            'accepted as a command-line argument.',
          { cause: error },
        );
      }

      // The first attempt rolled back in full, so nothing partial is left behind.
      result = await attach(await promptForNewAdministrator(options.email));
    }

    logger.info(
      {
        organizationId: result.organizationId,
        organizationSlug: result.organizationSlug,
        userId: result.userId,
        membershipId: result.membershipId,
        role: 'agency_admin',
        created: result.created,
      },
      result.created
        ? 'organization provisioned with its first agency_admin'
        : 'organization already provisioned; nothing was created',
    );
  } finally {
    await database.close();
  }
}

void main().catch((error: unknown) => {
  reportFailure(logger, 'provisioning failed', error);
});
