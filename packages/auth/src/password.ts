import { hash, verify, type Options } from '@node-rs/argon2';

import { InvalidPasswordInputError } from './errors.js';

/**
 * Password storage.
 *
 * Argon2id through a maintained native implementation (`@node-rs/argon2`, which ships
 * prebuilt binaries so CI and Windows development agree). No hashing, salting or
 * comparison is implemented here — the library owns all of it, including the
 * constant-time verification primitive (docs/SECURITY.md §2, CLAUDE.md).
 *
 * Nothing in this module logs, returns or embeds a plaintext password.
 */

export interface PasswordHashParameters {
  /** Memory cost in KiB. */
  readonly memoryCost: number;
  /** Iterations. */
  readonly timeCost: number;
  /** Degree of parallelism (lanes). */
  readonly parallelism: number;
}

/**
 * Production baseline: the first configuration in the OWASP Password Storage Cheat
 * Sheet for Argon2id — 19 MiB of memory, 2 iterations, 1 lane. It costs roughly
 * 40–70 ms per hash on a modern server core, which bounds how fast an attacker can
 * grind a stolen table while staying cheap enough for an interactive login.
 *
 * These are the *only* place the cost is defined; every consumer takes them from
 * configuration rather than restating numbers.
 */
export const DEFAULT_PASSWORD_HASH_PARAMETERS: PasswordHashParameters = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/**
 * Upper bound on the plaintext accepted for hashing. Argon2 itself is not sensitive
 * to input length, but an unbounded body would let a caller spend our memory for us.
 */
export const MAX_PASSWORD_LENGTH = 1024;

/** Minimum length for a password being *set*. Never applied at login: the login path
 * must not reveal anything about the stored credential, including its policy. */
export const MIN_PASSWORD_LENGTH = 12;

export interface PasswordHasher {
  /** @throws {InvalidPasswordInputError} when the plaintext is empty or oversized. */
  hash(password: string): Promise<string>;
  /**
   * Verifies a plaintext against a stored Argon2 encoded hash.
   *
   * Returns `false` rather than throwing for any unusable input (absent hash, hash
   * from another algorithm, corrupted encoding), so a malformed stored value can
   * never be mistaken for a successful authentication.
   */
  verify(storedHash: string | null | undefined, password: string): Promise<boolean>;
  readonly parameters: PasswordHashParameters;
}

/**
 * `Algorithm.Argon2id` from `@node-rs/argon2`.
 *
 * The library declares its algorithm identifiers as an ambient `const enum`, which
 * cannot be imported under `isolatedModules`, so the value is restated. A unit test
 * asserts that hashes produced with it really are `$argon2id$`, so a change in the
 * library cannot silently downgrade us to Argon2d or Argon2i.
 */
const ARGON2ID = 2 satisfies NonNullable<Options['algorithm']>;

function assertHashable(password: string): void {
  if (password.length === 0) {
    throw new InvalidPasswordInputError('Password must not be empty');
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new InvalidPasswordInputError(
      `Password must be at most ${String(MAX_PASSWORD_LENGTH)} characters`,
    );
  }
}

/**
 * Builds a hasher bound to one set of cost parameters.
 *
 * Parameters are injected rather than read from the environment here so that tests
 * can run at a low cost without a production code path ever seeing test values.
 */
export function createPasswordHasher(
  parameters: PasswordHashParameters = DEFAULT_PASSWORD_HASH_PARAMETERS,
): PasswordHasher {
  const options = {
    algorithm: ARGON2ID,
    memoryCost: parameters.memoryCost,
    timeCost: parameters.timeCost,
    parallelism: parameters.parallelism,
  } as const;

  return {
    parameters,

    async hash(password: string): Promise<string> {
      assertHashable(password);
      // The library generates a fresh cryptographically random salt per call, so two
      // hashes of the same password never match.
      return hash(password, options);
    },

    async verify(storedHash: string | null | undefined, password: string): Promise<boolean> {
      if (storedHash === null || storedHash === undefined || storedHash === '') {
        return false;
      }

      if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
        return false;
      }

      try {
        // Cost parameters come from the stored PHC string, so a hash written under an
        // older configuration still verifies; `options` only pins the algorithm.
        return await verify(storedHash, password, options);
      } catch {
        // A stored value we cannot parse is not a match. The failure is deliberately
        // not re-thrown and not logged with its input: the input is a password.
        return false;
      }
    },
  };
}

/** Result of checking a password that is being *set* (not one being verified). */
export interface PasswordPolicyResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

/**
 * Minimal policy for newly chosen passwords: length only.
 *
 * Composition rules ("one digit, one symbol") are deliberately absent — they reduce
 * entropy in practice. Breach-corpus checks belong with the account-management
 * features of a later phase.
 */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  const issues: string[] = [];

  if (password.length < MIN_PASSWORD_LENGTH) {
    issues.push(`must be at least ${String(MIN_PASSWORD_LENGTH)} characters`);
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    issues.push(`must be at most ${String(MAX_PASSWORD_LENGTH)} characters`);
  }

  return { ok: issues.length === 0, issues };
}
