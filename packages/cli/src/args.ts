/**
 * Argument parsing — a small, predictable getopt over a token list.
 *
 * Schema-less by design: it sorts tokens into positionals, `--key value` /
 * `--key=value` options, and `--flag` / `-abc` boolean flags, and a command
 * decides what they mean. The rules are chosen to be unsurprising and to have no
 * hidden state:
 *
 * - `--` ends option parsing; everything after is a positional (so a path that
 *   starts with `-` can still be passed).
 * - `--key=value` is always an option.
 * - `--key value` is an option when the next token is not itself an option;
 *   otherwise `--key` is a boolean flag.
 * - `-abc` is three short flags (`a`, `b`, `c`); single-dash tokens never take a
 *   value, which keeps short and long forms from having subtly different rules.
 * - anything else is a positional.
 */

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, string>>;
  readonly flags: ReadonlySet<string>;
}

function isOptionToken(token: string | undefined): boolean {
  return token !== undefined && token.startsWith('-') && token !== '-';
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string> = {};
  const flags = new Set<string>();
  let optionsEnded = false;
  // Set when a `--key value` consumed the following token as its value.
  let skipNext = false;

  // `entries()` types `token` as `string` (never `undefined`), avoiding an
  // index read that would force either a banned assertion or a dead branch.
  for (const [i, token] of argv.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (optionsEnded) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      optionsEnded = true;
      continue;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      const next = argv[i + 1];
      if (eq >= 0) {
        options[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (next === undefined || isOptionToken(next)) {
        // A trailing `--flag`, or one followed by another option: a boolean.
        flags.add(body);
      } else {
        options[body] = next;
        skipNext = true;
      }
      continue;
    }

    if (token.startsWith('-') && token !== '-') {
      for (const char of token.slice(1)) flags.add(char);
      continue;
    }

    positionals.push(token);
  }

  return { positionals, options, flags };
}
