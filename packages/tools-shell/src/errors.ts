/**
 * Shell errors.
 *
 * The vocabulary is small and the distinction that matters is **"could not run"
 * versus "ran and failed"**. A command that exits non-zero is *not* an error
 * here — it is a `ShellResult` with a non-zero code, because a failed command is
 * information an agent reasons about. A `ShellError` means the command never ran:
 * it was not allowed, not found, or the executor itself broke.
 *
 * Same contract as every layer: a stable `code`, message wording free to change
 * (RFC-0001 §5), no relation to `KernelError`.
 */

export type ShellErrorCode = 'NOT_ALLOWED' | 'NOT_FOUND' | 'SPAWN_FAILED';

export class ShellError extends Error {
  readonly code: ShellErrorCode;
  /** The program that could not be run. Always present. */
  readonly command: string;

  constructor(
    code: ShellErrorCode,
    command: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`"${command}" ${detail}`, options);
    this.name = new.target.name;
    this.code = code;
    this.command = command;
  }
}

/**
 * Translate a Node spawn failure into a {@link ShellError}.
 *
 * The one that matters is `ENOENT`, which for a *spawn* means the program does
 * not exist — a different thing from a file read's `ENOENT`, and it deserves a
 * message a model can act on ("no such command" invites checking the name, where
 * a raw errno invites nothing).
 */
export function fromSpawnError(command: string, thrown: unknown): ShellError {
  if (thrown instanceof ShellError) return thrown;

  const code = (thrown as { code?: unknown }).code;
  if (code === 'ENOENT') {
    return new ShellError('NOT_FOUND', command, 'is not an executable on the PATH', {
      cause: thrown,
    });
  }
  return new ShellError(
    'SPAWN_FAILED',
    command,
    `could not be started: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    { cause: thrown },
  );
}
