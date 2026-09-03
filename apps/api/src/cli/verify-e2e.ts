import { parseArgs } from 'node:util';

import { readSecretFromTty } from '@organic-os/database';

import { DEFAULT_API, runVerification } from './verification.js';

/**
 * `pnpm verify:e2e` — drives a running API the way a browser does, end to end.
 *
 *   pnpm verify:e2e --email ada@acme.test
 *   pnpm verify:e2e --email ada@acme.test --api https://api.example.com
 *
 * This command is the terminal around `runVerification`, and its whole job is the
 * password. **It is typed here with the echo off and is never an argument or an
 * environment variable**, for the reason `provision:organization` gives: argv and
 * `/proc/<pid>/environ` are readable, and an administrator credential must be in
 * neither. Nothing on either side of this file logs it.
 *
 * The checks themselves live in `verification.ts` so they can be exercised without a
 * terminal.
 */

interface Options {
  readonly email: string;
  readonly api: string;
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm verify:e2e --email <address> [--api <base url>]',
    '',
    'Options:',
    '  --email   The agency_admin to sign in as. Provision one first with',
    '            `pnpm provision:organization`.',
    `  --api     API base URL. Default ${DEFAULT_API}`,
    '',
    'The password is prompted for on the terminal and is never accepted as an',
    'argument or an environment variable.',
  ].join('\n');
}

function readOptions(argv: readonly string[]): Options {
  const { values } = parseArgs({
    args: [...argv],
    options: { email: { type: 'string' }, api: { type: 'string' } },
    strict: true,
  });

  if (values.email === undefined || values.email === '') {
    throw new Error(`Missing required option: --email\n\n${usage()}`);
  }

  return { email: values.email, api: (values.api ?? DEFAULT_API).replace(/\/+$/, '') };
}

async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2));

  process.stdout.write(`\nVerifying ${options.api} as ${options.email}\n\n`);

  const password = await readSecretFromTty('Password (not echoed): ', { echo: false });

  if (password === '') {
    throw new Error('A password is required');
  }

  const passed = await runVerification({ api: options.api, email: options.email, password });

  if (!passed) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `\nverification failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
