/**
 * The output parsers, against crafted git output.
 *
 * Pure functions of a string, so every branch is a plain input/output case. The
 * inputs here are the exact bytes git emits for the stable formats the tools ask
 * for — confirmed against real git in `integration.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { parseStatus, parseLog, parseBranches, LOG_FORMAT } from '../src/parse.js';

describe('parseStatus', () => {
  it('reads the branch and ahead/behind from the header', () => {
    const status = parseStatus('## main...origin/main [ahead 2, behind 3]\n');
    expect(status.branch).toBe('main');
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(3);
  });

  it('reads a branch with no upstream', () => {
    const status = parseStatus('## main\n');
    expect(status.branch).toBe('main');
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  it('reads ahead without behind', () => {
    const status = parseStatus('## main...origin/main [ahead 1]\n');
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(0);
  });

  it('classifies the four states from the porcelain columns', () => {
    const status = parseStatus(
      [
        '## main',
        'M  staged.ts',
        ' M unstaged.ts',
        'MM both.ts',
        '?? untracked.ts',
      ].join('\n'),
    );
    expect(status.entries).toEqual([
      { path: 'staged.ts', state: 'staged', code: 'M ' },
      { path: 'unstaged.ts', state: 'unstaged', code: ' M' },
      { path: 'both.ts', state: 'both', code: 'MM' },
      { path: 'untracked.ts', state: 'untracked', code: '??' },
    ]);
  });

  it('is clean when there are no entries', () => {
    expect(parseStatus('## main\n').clean).toBe(true);
    expect(parseStatus('## main\n M x\n').clean).toBe(false);
  });

  it('reports a clean, branchless repository from empty output', () => {
    const status = parseStatus('');
    expect(status.branch).toBeUndefined();
    expect(status.clean).toBe(true);
    expect(status.entries).toEqual([]);
  });

  // A defensive guard: porcelain lines are always `XY path`, so anything shorter
  // is not one and must not become a bogus entry.
  it('ignores a line too short to be a porcelain entry', () => {
    expect(parseStatus('## main\nx\n').entries).toEqual([]);
  });
});

describe('parseLog', () => {
  const record = (fields: string[]): string => fields.join('\x1f') + '\x1e';

  it('splits records and fields on the control characters', () => {
    const stdout =
      record(['abc123', 'Ada', 'ada@x.dev', '2026-01-01T00:00:00Z', 'First']) +
      '\n' +
      record(['def456', 'Bo', 'bo@x.dev', '2026-01-02T00:00:00Z', 'Second']);

    expect(parseLog(stdout)).toEqual([
      {
        hash: 'abc123',
        author: 'Ada',
        email: 'ada@x.dev',
        date: '2026-01-01T00:00:00Z',
        subject: 'First',
      },
      {
        hash: 'def456',
        author: 'Bo',
        email: 'bo@x.dev',
        date: '2026-01-02T00:00:00Z',
        subject: 'Second',
      },
    ]);
  });

  // The reason for control-character delimiters: a subject the model must not be
  // able to break the format with.
  it('keeps a subject that contains pipes and newlines-worth of punctuation', () => {
    const [entry] = parseLog(record(['h', 'a', 'e', 'd', 'feat: a | b || c']));
    expect(entry?.subject).toBe('feat: a | b || c');
  });

  it('returns nothing for empty output', () => {
    expect(parseLog('')).toEqual([]);
  });

  it('fills missing trailing fields with empty strings', () => {
    const [entry] = parseLog('onlyhash\x1e');
    expect(entry).toEqual({
      hash: 'onlyhash',
      author: '',
      email: '',
      date: '',
      subject: '',
    });
  });

  it('exposes the format string it expects', () => {
    expect(LOG_FORMAT).toContain('%H');
    expect(LOG_FORMAT).toContain('%x1e');
  });
});

describe('parseBranches', () => {
  it('marks the current branch and lists them all', () => {
    const branches = parseBranches('* main\n  feature/x\n  release\n');
    expect(branches.current).toBe('main');
    expect(branches.all).toEqual(['main', 'feature/x', 'release']);
  });

  it('has no current branch on a detached HEAD listing', () => {
    const branches = parseBranches('  main\n  feature/x\n');
    expect(branches.current).toBeUndefined();
    expect(branches.all).toEqual(['main', 'feature/x']);
  });

  it('strips the worktree `+` marker git prints', () => {
    expect(parseBranches('+ wt-branch\n').all).toEqual(['wt-branch']);
  });

  it('ignores blank lines', () => {
    expect(parseBranches('* main\n\n  x\n').all).toEqual(['main', 'x']);
  });
});
