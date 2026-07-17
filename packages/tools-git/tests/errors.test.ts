/**
 * Error classification, against representative git stderr.
 *
 * The classifier reads git's human-facing messages — fragile by nature — so these
 * pin the strings it keys on, and prove the fallthrough carries the raw stderr
 * rather than guessing.
 */

import { describe, expect, it } from 'vitest';
import { GitError, classifyGitFailure } from '../src/errors.js';

describe('GitError', () => {
  it('carries a stable code and the stderr', () => {
    const err = new GitError('PATH_ESCAPE', 'nope', { stderr: 'raw' });
    expect(err.code).toBe('PATH_ESCAPE');
    expect(err.stderr).toBe('raw');
    expect(err.name).toBe('GitError');
    expect(err).toBeInstanceOf(Error);
  });

  it('has no stderr when none is given', () => {
    expect(new GitError('GIT_FAILED', 'x').stderr).toBeUndefined();
  });
});

describe('classifyGitFailure', () => {
  const cases: readonly [string, string, string][] = [
    [
      'NOT_A_REPOSITORY',
      'fatal: not a git repository (or any of the parent directories)',
      'status',
    ],
    ['MERGE_CONFLICT', 'CONFLICT (content): Merge conflict in a.txt', 'merge'],
    ['AUTH_FAILED', 'fatal: Authentication failed for https://github.com/x/y', 'push'],
    ['AUTH_FAILED', 'fatal: could not read Username for https://github.com', 'push'],
    ['REJECTED', '! [rejected] main -> main (non-fast-forward)', 'push'],
    ['NOTHING_TO_COMMIT', 'nothing to commit, working tree clean', 'commit'],
    [
      'REMOTE_ERROR',
      'fatal: unable to access https://github.com/x/y: Could not resolve host',
      'fetch',
    ],
  ];

  for (const [code, stderr, command] of cases) {
    it(`classifies ${code}`, () => {
      const err = classifyGitFailure(command, stderr);
      expect(err.code).toBe(code);
      expect(err.stderr).toBe(stderr);
      expect(err.message).toContain(`git ${command} failed`);
    });
  }

  it('falls through to GIT_FAILED with the first stderr line', () => {
    const err = classifyGitFailure(
      'checkout',
      "error: pathspec 'nope' did not match\nsecond line",
    );
    expect(err.code).toBe('GIT_FAILED');
    expect(err.message).toContain("error: pathspec 'nope' did not match");
    expect(err.message).not.toContain('second line');
  });

  it('gives a generic message when stderr is empty', () => {
    const err = classifyGitFailure('log', '');
    expect(err.code).toBe('GIT_FAILED');
    expect(err.message).toContain('exited with an error');
  });
});
