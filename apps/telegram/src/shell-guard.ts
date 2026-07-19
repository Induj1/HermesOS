/**
 * A safety guard over the shell executor.
 *
 * The allowlist already restricts which *programs* run, but an allowed program
 * (node, npm) can be told to do dangerous things. This inspects the whole
 * command line — including args, so `node -e "…rm -rf…"` is caught — and refuses
 * anything matching a deny pattern before it runs.
 *
 * This is a hard block, not an interactive "ask the user y/n" approval: a true
 * mid-run approval needs the agent framework to suspend and resume a run, which
 * it does not support today. A denylist is the honest, shippable safety layer.
 */

import type { ShellExecutor } from '@hermes/tools-shell';

/** Command-line patterns refused by default (case-insensitive). */
export const DEFAULT_DENY: readonly RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f?\b/i,
  /--force\b/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\//i,
  /:\(\)\s*\{/, // fork bomb
  /\bchmod\s+-?R?\s*777\b/i,
  /\b(shutdown|reboot|halt)\b/i,
  /\bcurl\b[^|]*\|\s*(sh|bash)\b/i,
];

/** Wrap an executor so commands matching a deny pattern are refused. */
export function guardedShell(
  inner: ShellExecutor,
  denyPatterns: readonly RegExp[] = DEFAULT_DENY,
): ShellExecutor {
  return {
    run: (command, args, options) => {
      const line = [command, ...args].join(' ');
      const matched = denyPatterns.find((pattern) => pattern.test(line));
      if (matched !== undefined) {
        return Promise.reject(
          new Error(
            `Refused by the safety guard (matched /${matched.source}/): ${line}. ` +
              `Ask the user to run this themselves if it is really intended.`,
          ),
        );
      }
      return inner.run(command, args, options);
    },
  };
}
