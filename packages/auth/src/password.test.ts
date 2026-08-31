import { describe, expect, it } from 'vitest';

import { InvalidPasswordInputError } from './errors.js';
import {
  checkPasswordPolicy,
  createPasswordHasher,
  DEFAULT_PASSWORD_HASH_PARAMETERS,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from './password.js';

/**
 * Test-only cost parameters. Production values live in `DEFAULT_PASSWORD_HASH_PARAMETERS`
 * and are asserted separately below; hashing at 19 MiB in a unit test would add
 * seconds for no additional coverage.
 */
const hasher = createPasswordHasher({ memoryCost: 8_192, timeCost: 1, parallelism: 1 });

const PASSWORD = 'correct horse battery staple';

describe('password hashing', () => {
  it('produces a hash that verifies against the original password', async () => {
    const hash = await hasher.hash(PASSWORD);
    await expect(hasher.verify(hash, PASSWORD)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hasher.hash(PASSWORD);

    await expect(hasher.verify(hash, 'correct horse battery stapl')).resolves.toBe(false);
    await expect(hasher.verify(hash, PASSWORD.toUpperCase())).resolves.toBe(false);
    await expect(hasher.verify(hash, '')).resolves.toBe(false);
  });

  it('uses argon2id, not argon2i or argon2d', async () => {
    // Guards the locally restated algorithm identifier against a library change.
    expect(await hasher.hash(PASSWORD)).toMatch(/^\$argon2id\$/);
  });

  it('salts every hash, so the same password never produces the same digest', async () => {
    const [first, second] = await Promise.all([hasher.hash(PASSWORD), hasher.hash(PASSWORD)]);

    expect(first).not.toBe(second);
    await expect(hasher.verify(first, PASSWORD)).resolves.toBe(true);
    await expect(hasher.verify(second, PASSWORD)).resolves.toBe(true);
  });

  it('never embeds the plaintext in the stored value', async () => {
    const hash = await hasher.hash(PASSWORD);

    expect(hash).not.toContain(PASSWORD);
    expect(hash).not.toContain('correct');
    expect(hash).not.toContain('staple');
    // PHC string: algorithm, version, parameters, salt, digest — nothing else.
    expect(hash.split('$')).toHaveLength(6);
  });

  it('treats an unusable stored value as a failed verification, not an error', async () => {
    await expect(hasher.verify(null, PASSWORD)).resolves.toBe(false);
    await expect(hasher.verify(undefined, PASSWORD)).resolves.toBe(false);
    await expect(hasher.verify('', PASSWORD)).resolves.toBe(false);
    await expect(hasher.verify('not-a-hash', PASSWORD)).resolves.toBe(false);
    await expect(hasher.verify('$argon2id$v=19$m=8,t=1,p=1$aaaa$bbbb', PASSWORD)).resolves.toBe(
      false,
    );
  });

  it('refuses to hash an empty or oversized password', async () => {
    await expect(hasher.hash('')).rejects.toBeInstanceOf(InvalidPasswordInputError);
    await expect(hasher.hash('x'.repeat(MAX_PASSWORD_LENGTH + 1))).rejects.toBeInstanceOf(
      InvalidPasswordInputError,
    );
  });

  it('never puts the password into the error it throws', async () => {
    const secret = 'a'.repeat(MAX_PASSWORD_LENGTH + 1);
    await expect(hasher.hash(secret)).rejects.toSatisfy(
      (error: unknown) => error instanceof Error && !error.message.includes('aaaa'),
    );
  });

  it('exposes the parameters it was built with', () => {
    expect(hasher.parameters).toEqual({ memoryCost: 8_192, timeCost: 1, parallelism: 1 });
  });
});

describe('production hash parameters', () => {
  it('meets the OWASP Argon2id baseline', () => {
    // 19 MiB / 2 iterations / 1 lane. Lowering any of these is a security decision,
    // so it has to break a test rather than pass review as a config tweak.
    expect(DEFAULT_PASSWORD_HASH_PARAMETERS.memoryCost).toBeGreaterThanOrEqual(19_456);
    expect(DEFAULT_PASSWORD_HASH_PARAMETERS.timeCost).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_PASSWORD_HASH_PARAMETERS.parallelism).toBeGreaterThanOrEqual(1);
  });
});

describe('password policy', () => {
  it('accepts a password of at least the minimum length', () => {
    expect(checkPasswordPolicy('x'.repeat(MIN_PASSWORD_LENGTH))).toEqual({ ok: true, issues: [] });
  });

  it('rejects a short password and says why without echoing it', () => {
    const result = checkPasswordPolicy('short');

    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues.join(' ')).not.toContain('short');
  });

  it('rejects an oversized password', () => {
    expect(checkPasswordPolicy('x'.repeat(MAX_PASSWORD_LENGTH + 1)).ok).toBe(false);
  });
});
