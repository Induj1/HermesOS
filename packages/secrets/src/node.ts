/**
 * The Node filesystem adapter — the one place this package touches real I/O.
 * Isolated here so `source.ts` stays a pure function of an injected `FileReader`
 * and every branch is testable without the filesystem.
 */

import { readFile } from 'node:fs/promises';
import type { FileReader } from './source.js';

interface NodeError {
  readonly code?: string;
}

/**
 * A `FileReader` backed by `node:fs`. A missing file resolves to `undefined`
 * (an absent secret, not an error); any other failure — a permissions problem,
 * a directory where a file was expected — propagates, because that is a
 * misconfiguration the operator must see, not a silent "no secret".
 */
export function nodeFileReader(): FileReader {
  return async (path: string) => {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeError).code === 'ENOENT') return undefined;
      throw error;
    }
  };
}
