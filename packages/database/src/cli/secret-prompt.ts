/**
 * Reading a value from the terminal without putting it anywhere it can be recovered.
 *
 * A first-administrator password cannot be a command-line argument: argv is visible
 * in shell history, in `ps`, in process listings and in whatever the operator's shell
 * writes to disk. It also cannot be an environment variable for the same reason —
 * `/proc/<pid>/environ`, crash dumps and process inspectors all read those. So it is
 * typed, once, into a terminal that is not echoing it (§14 of the sub-phase brief).
 *
 * The echo is suppressed with raw mode and manual character handling rather than by
 * reaching into `readline`'s private `_writeToOutput`, which is what most snippets
 * do. `setRawMode` and the `data` event are public API, so this cannot break on a
 * Node release that tidies its internals — and correctness here is not cosmetic: a
 * failure mode of the private-API version is that the password is echoed.
 *
 * Nothing read here is logged, returned in an error message, or retained after the
 * caller has hashed it.
 */

export interface ReadSecretOptions {
  /** True for ordinary prompts (a name); false for anything that must not appear. */
  readonly echo: boolean;
}

const ENTER: readonly string[] = ['\r', '\n'];
/** Backspace and DEL: terminals disagree about which one the key sends. */
const BACKSPACE: readonly string[] = ['\u0008', '\u007f'];
/** Ctrl+C. */
const END_OF_TEXT = '\u0003';
/** Ctrl+D. */
const END_OF_TRANSMISSION = '\u0004';

/**
 * Prompts on stdout and reads one line from a TTY.
 *
 * @throws {Error} when stdin is not a terminal — a redirected stdin would silently
 * consume whatever is piped in, which for a credential prompt is worse than failing.
 */
export async function readSecretFromTty(
  prompt: string,
  options: ReadSecretOptions,
): Promise<string> {
  const input = process.stdin;

  if (!input.isTTY) {
    throw new Error('A terminal is required for this prompt');
  }

  process.stdout.write(prompt);

  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');

  return new Promise<string>((resolve, reject) => {
    let value = '';

    const finish = (): void => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
    };

    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (ENTER.includes(character)) {
          finish();
          resolve(value);
          return;
        }

        if (character === END_OF_TEXT || character === END_OF_TRANSMISSION) {
          finish();
          reject(new Error('Cancelled'));
          return;
        }

        if (BACKSPACE.includes(character)) {
          if (value.length > 0) {
            value = value.slice(0, -1);

            if (options.echo) {
              process.stdout.write('\b \b');
            }
          }

          continue;
        }

        value += character;

        if (options.echo) {
          process.stdout.write(character);
        }
      }
    };

    input.on('data', onData);
  });
}
