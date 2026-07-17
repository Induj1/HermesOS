/**
 * The errno mapping table — one test per row.
 *
 * `fromNodeError` turns Node's errno grab-bag into a stable vocabulary a model
 * can act on, and a mapping table is exactly the thing that is easy to get subtly
 * wrong (is `ENOTEMPTY` a `NOT_A_DIRECTORY`? no). Each row is checked in
 * isolation, with a fake errno object, so the table's correctness does not depend
 * on being able to provoke each errno from a real disk.
 */

import { describe, expect, it } from 'vitest';
import { FileSystemError, fromNodeError } from '../src/errors.js';

const errno = (code: string): Error =>
  Object.assign(new Error(`${code}: something`), { code });

describe('fromNodeError', () => {
  it.each([
    ['ENOENT', 'NOT_FOUND'],
    ['EEXIST', 'ALREADY_EXISTS'],
    ['ENOTDIR', 'NOT_A_DIRECTORY'],
    ['EISDIR', 'IS_A_DIRECTORY'],
    ['ENOTEMPTY', 'IS_A_DIRECTORY'],
    ['EACCES', 'PERMISSION_DENIED'],
    ['EPERM', 'PERMISSION_DENIED'],
  ] as const)('maps %s to %s', (code, expected) => {
    const error = fromNodeError('/x', errno(code));

    expect(error).toBeInstanceOf(FileSystemError);
    expect(error.code).toBe(expected);
    expect(error.path).toBe('/x');
  });

  // An unrecognised errno must surface as a real error with the cause attached,
  // not be swallowed into a generic message that hides a full disk or a severed
  // mount.
  it('maps an unknown errno to IO_ERROR, keeping the cause', () => {
    const original = errno('ENOSPC');
    const error = fromNodeError('/x', original);

    expect(error.code).toBe('IO_ERROR');
    expect(error.cause).toBe(original);
  });

  it('handles a thrown value with no code at all', () => {
    const error = fromNodeError('/x', new Error('mystery'));

    expect(error.code).toBe('IO_ERROR');
    expect(error.message).toContain('mystery');
  });

  it('falls back to stringifying a non-Error thrown for an unknown code', () => {
    // A rejected value that is neither a FileSystemError nor an Error with a
    // message — the `?? String(thrown)` arm of the IO_ERROR default.
    const error = fromNodeError('/x', { code: 'EWEIRD' });

    expect(error.code).toBe('IO_ERROR');
    expect(error.message).toContain('[object Object]');
  });

  // Idempotent: a FileSystemError passed back in is returned unchanged, so a
  // double-wrap in a catch chain does not bury the real code under IO_ERROR.
  it('passes a FileSystemError straight through', () => {
    const original = new FileSystemError('TOO_LARGE', '/x', 'is too big');

    expect(fromNodeError('/y', original)).toBe(original);
  });

  it('names the path and gives an actionable message', () => {
    expect(fromNodeError('/etc/hosts', errno('ENOENT')).message).toBe(
      '"/etc/hosts" does not exist',
    );
  });
});
