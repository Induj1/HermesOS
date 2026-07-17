/**
 * Filesystem errors.
 *
 * The point of this file is to turn `node:fs`'s errno grab-bag — `ENOENT`,
 * `EACCES`, `EISDIR`, `ENOTDIR`, `EEXIST` — into a small, stable vocabulary a
 * tool can branch on and a model can act on. A raw `ENOENT: no such file or
 * directory, open '/work/x'` tells a model nothing it can use; `NOT_FOUND` with
 * the path does.
 *
 * Same contract as every layer below: a stable machine-readable `code`, message
 * wording free to change (RFC-0001 §5), and no relation to `KernelError`.
 */

export type FileSystemErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'NOT_A_DIRECTORY'
  | 'IS_A_DIRECTORY'
  | 'PERMISSION_DENIED'
  | 'PATH_ESCAPE'
  | 'TOO_LARGE'
  | 'NOT_TEXT'
  | 'IO_ERROR';

export class FileSystemError extends Error {
  readonly code: FileSystemErrorCode;
  /** The path that failed. Always present; a filesystem error without one is unactionable. */
  readonly path: string;

  constructor(
    code: FileSystemErrorCode,
    path: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`"${path}" ${detail}`, options);
    this.name = new.target.name;
    this.code = code;
    this.path = path;
  }
}

/**
 * Translate a Node filesystem error into a {@link FileSystemError}.
 *
 * Lives here, not in `NodeFileSystem`, because it is the one piece of Node
 * coupling worth testing in isolation — the mapping from errno to code is a table
 * that is easy to get subtly wrong (is `ENOTEMPTY` a `NOT_A_DIRECTORY`? no, it is
 * an `IS_A_DIRECTORY`-shaped "you need recursive") and a table is exactly what
 * should have a test per row.
 *
 * An unrecognised errno becomes `IO_ERROR` rather than being swallowed: a
 * filesystem can fail in ways this table does not enumerate (a full disk, a
 * severed network mount), and those must surface as a real error with the
 * original attached, not as a generic message that hides the cause.
 */
export function fromNodeError(path: string, thrown: unknown): FileSystemError {
  if (thrown instanceof FileSystemError) return thrown;

  const code = (thrown as { code?: unknown }).code;
  const options = { cause: thrown };

  switch (code) {
    case 'ENOENT':
      return new FileSystemError('NOT_FOUND', path, 'does not exist', options);
    case 'EEXIST':
      return new FileSystemError('ALREADY_EXISTS', path, 'already exists', options);
    case 'ENOTDIR':
      return new FileSystemError(
        'NOT_A_DIRECTORY',
        path,
        'is not a directory',
        options,
      );
    case 'EISDIR':
      return new FileSystemError('IS_A_DIRECTORY', path, 'is a directory', options);
    case 'ENOTEMPTY':
      return new FileSystemError(
        'IS_A_DIRECTORY',
        path,
        'is a directory that is not empty; removing it needs the recursive option',
        options,
      );
    case 'EACCES':
    case 'EPERM':
      return new FileSystemError(
        'PERMISSION_DENIED',
        path,
        'cannot be accessed',
        options,
      );
    default:
      // `instanceof`, not `as Error`: a rejected value may be a plain object with
      // no `message`, and casting it to `Error` would type its `message` as a
      // string it does not have — the lie only shows up at runtime as
      // `undefined` in the message. Checking is honest and gives a real fallback.
      return new FileSystemError(
        'IO_ERROR',
        path,
        `could not be accessed: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
        options,
      );
  }
}
