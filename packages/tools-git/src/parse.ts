/**
 * Parsers for git's machine-readable output.
 *
 * These turn git's porcelain formats into structured data, and they are pure
 * functions of a string — so they are tested exhaustively against crafted output
 * (`parse.test.ts`) and confirmed against real git separately
 * (`integration.test.ts`). The parsing is the interesting, breakable part of the
 * read tools, so it is isolated here where it can be tested without a repository.
 *
 * Every parser reads a **stable** git format — `--porcelain`, an explicit
 * `--format` with control-character separators — never the human-facing default,
 * which git is free to reword and re-align between versions. A tool that scraped
 * `git status`'s prose would break on the next git release; a tool that reads
 * `--porcelain=v1` will not, because that format is a documented contract.
 */

/** A single file's state in `git status --porcelain=v1`. */
export interface StatusEntry {
  readonly path: string;
  /**
   * Whether the change is staged, unstaged, or the file is untracked. Derived
   * from porcelain's two status columns — the reason a model cares, condensed.
   */
  readonly state: 'staged' | 'unstaged' | 'both' | 'untracked';
  /** The raw two-character porcelain code (`M `, ` M`, `??`, `MM`, …), for the exact truth. */
  readonly code: string;
}

export interface Status {
  readonly branch: string | undefined;
  readonly ahead: number;
  readonly behind: number;
  readonly entries: readonly StatusEntry[];
  /** True when there is nothing to commit and nothing untracked. */
  readonly clean: boolean;
}

/**
 * Parse `git status --porcelain=v1 --branch`.
 *
 * v1 is chosen over v2 deliberately: v1 is simpler, its columns are stable, and
 * it carries everything the tools surface. v2 adds submodule and rename detail no
 * current tool uses, at the cost of a much larger grammar to get wrong.
 */
export function parseStatus(stdout: string): Status {
  const lines = stdout.split('\n').filter((line) => line !== '');
  let branch: string | undefined;
  let ahead = 0;
  let behind = 0;
  const entries: StatusEntry[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const header = line.slice(3);
      // `main...origin/main [ahead 1, behind 2]` — the branch is up to the first
      // `...` or space, and the tracking info is in the brackets.
      branch = header.split(/\.\.\.| /)[0];
      ahead = Number(/ahead (\d+)/.exec(header)?.[1] ?? '0');
      behind = Number(/behind (\d+)/.exec(header)?.[1] ?? '0');
      continue;
    }

    // Two status columns, a space, then the path. A porcelain line is always at
    // least `XY path`, so a line shorter than that is not one.
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3);
    entries.push({ path, state: stateOf(code), code });
  }

  return { branch, ahead, behind, entries, clean: entries.length === 0 };
}

function stateOf(code: string): StatusEntry['state'] {
  if (code === '??') return 'untracked';
  const [index, worktree] = code;
  const staged = index !== ' ' && index !== '?';
  const unstaged = worktree !== ' ' && worktree !== '?';
  if (staged && unstaged) return 'both';
  if (staged) return 'staged';
  return 'unstaged';
}

/** One commit from a `--format`-controlled `git log`. */
export interface LogEntry {
  readonly hash: string;
  readonly author: string;
  readonly email: string;
  /** Author date, ISO 8601. */
  readonly date: string;
  readonly subject: string;
}

/**
 * The `--format` string {@link parseLog} expects. Exported so the tool and the
 * parser cannot disagree about the layout — they share one constant.
 *
 * Fields are separated by the unit-separator control character (`\x1f`) and
 * records by the record-separator (`\x1e`), rather than by a printable delimiter
 * a commit subject could contain. A commit message with a `|` in it would break a
 * pipe-delimited format; nothing a human types contains `\x1f`.
 */
export const LOG_FORMAT = '%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e';

export function parseLog(stdout: string): readonly LogEntry[] {
  return stdout
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record !== '')
    .map((record) => {
      const [hash = '', author = '', email = '', date = '', subject = ''] =
        record.split('\x1f');
      return { hash, author, email, date, subject };
    });
}

/** The output of `git branch --format` — the branches and which one is current. */
export interface Branches {
  readonly current: string | undefined;
  readonly all: readonly string[];
}

/**
 * Parse `git branch --format='%(refname:short)'` plus a marker for the current.
 *
 * The tool runs `git branch` with a format that prefixes the current branch, so
 * this reads a simple list. `git symbolic-ref` would name the current branch more
 * directly, but at the cost of a second command; one `git branch` gives both.
 */
export function parseBranches(stdout: string): Branches {
  const all: string[] = [];
  let current: string | undefined;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // A leading `*` marks the current branch, as `git branch` prints it.
    if (trimmed.startsWith('* ')) {
      const name = trimmed.slice(2).trim();
      current = name;
      all.push(name);
    } else {
      all.push(trimmed.replace(/^\+ /, ''));
    }
  }

  return { current, all };
}
