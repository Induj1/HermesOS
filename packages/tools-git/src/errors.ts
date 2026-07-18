/**
 * Git errors.
 *
 * The now-familiar split: a `git` command that *ran and failed* (a merge
 * conflict, a rejected push, a dirty working tree) is not an error — it is a
 * result the tools turn into a structured outcome an agent reasons about. A
 * `GitError` means the command could not run, or the framework refused it: git is
 * not installed, the cwd escaped the root, the directory is not a repository.
 *
 * The interesting move here is {@link classifyGitFailure}: many git failures are
 * best surfaced with a specific code even though git reports them all as a
 * non-zero exit, because a model told `MERGE_CONFLICT` can act (resolve, abort)
 * where a model told "exit 1" cannot. That classification reads stderr, which is
 * fragile — so it is a *best-effort enrichment*, never the source of truth: the
 * exit code and the raw stderr are always available, and the code is a hint on
 * top.
 */

export type GitErrorCode =
  | 'NOT_INSTALLED'
  | 'NOT_A_REPOSITORY'
  | 'PATH_ESCAPE'
  | 'UNSAFE_URL'
  | 'MERGE_CONFLICT'
  | 'AUTH_FAILED'
  | 'REMOTE_ERROR'
  | 'NOTHING_TO_COMMIT'
  | 'REJECTED'
  | 'GIT_FAILED';

export class GitError extends Error {
  readonly code: GitErrorCode;
  /** git's stderr, when the failure came from a run. What a human debugs with. */
  readonly stderr: string | undefined;

  constructor(
    code: GitErrorCode,
    message: string,
    options?: ErrorOptions & { stderr?: string },
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.stderr = options?.stderr;
  }
}

/**
 * Turn a failed `git` run into a specific error, when the stderr is recognisable.
 *
 * A best-effort classifier over git's human-facing stderr. It is deliberately
 * conservative: an unrecognised failure becomes `GIT_FAILED` with the stderr
 * attached, never a wrong guess. The patterns are matched loosely (git rewords
 * its messages between versions) and the stderr is always carried, so a caller
 * that does not trust the code can read the text.
 *
 * `NOT_INSTALLED` is not classified here — a missing `git` fails to *spawn*, which
 * the executor surfaces before any stderr exists.
 *
 * Both streams are read, because git is not consistent about which it uses: a
 * failed push writes to stderr, but "nothing to commit" goes to stdout. The
 * carried {@link GitError.stderr} is still only stderr — what a human debugs with —
 * but the *classification* looks at everything git said.
 */
export function classifyGitFailure(
  command: string,
  stderr: string,
  stdout = '',
): GitError {
  const lower = (stderr + '\n' + stdout).toLowerCase();

  const detail = (code: GitErrorCode, message: string): GitError =>
    new GitError(code, `git ${command} failed: ${message}`, { stderr });

  if (lower.includes('not a git repository')) {
    return detail('NOT_A_REPOSITORY', 'the directory is not a git repository');
  }
  if (lower.includes('conflict') && lower.includes('merge')) {
    return detail('MERGE_CONFLICT', 'the merge left conflicts to resolve');
  }
  if (
    lower.includes('authentication failed') ||
    lower.includes('could not read username')
  ) {
    return detail('AUTH_FAILED', 'authentication to the remote failed');
  }
  if (lower.includes('rejected') && lower.includes('non-fast-forward')) {
    return detail(
      'REJECTED',
      'the push was rejected; the remote has commits you do not',
    );
  }
  if (lower.includes('nothing to commit')) {
    return detail('NOTHING_TO_COMMIT', 'there is nothing staged to commit');
  }
  if (lower.includes('could not resolve host') || lower.includes('unable to access')) {
    return detail('REMOTE_ERROR', 'the remote could not be reached');
  }
  return detail(
    'GIT_FAILED',
    firstLine(stderr) || firstLine(stdout) || 'the command exited with an error',
  );
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}

// A git "remote helper" URL has the form `<transport>::<address>`, and some
// transports run a command: `ext::sh -c '…'` and `fd::` hand git an arbitrary
// program to execute. That turns a clone URL into code execution.
const REMOTE_HELPER = /^[a-z][a-z0-9+.-]*::/i;

/**
 * Reject a clone URL that would trigger a git remote-helper transport (the
 * `<transport>::<address>` form, e.g. `ext::sh -c '…'`). Normal URLs —
 * `https://`, `git://`, `ssh://`, `file://`, and the scp-like `user@host:path` —
 * all pass; only the `::` transport form and an empty URL are refused. This is
 * defense in depth: the tool is already gated behind `git:network`, but a
 * model-produced URL should never be able to run a command.
 */
export function assertCloneUrlSafe(url: string): void {
  const trimmed = url.trim();
  if (trimmed === '') {
    throw new GitError('UNSAFE_URL', 'a clone URL must not be empty');
  }
  if (REMOTE_HELPER.test(trimmed)) {
    throw new GitError(
      'UNSAFE_URL',
      `refusing to clone a git remote-helper transport URL ("${firstLine(trimmed)}"); use https://, git://, ssh://, file://, or user@host:path`,
    );
  }
}
