/**
 * Repo Q&A: ingest a local source repo so you can ask questions across the whole
 * codebase. The walk and embedding are impure (main.ts); this module is the pure
 * decision of which paths are worth ingesting — skipping vendored trees, build
 * output, lockfiles, and binary assets so the index stays small and relevant.
 */

/** Directory names that are never ingested (vendored, generated, or heavy). */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '.venv',
  '.venv-sd',
  '__pycache__',
  'vendor',
  'target',
  'bin',
  'obj',
]);

/** File extensions that are binary or otherwise not worth embedding. */
const SKIP_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'ico',
  'pdf',
  'zip',
  'gz',
  'tar',
  'tgz',
  'mp3',
  'mp4',
  'wav',
  'ogg',
  'mov',
  'woff',
  'woff2',
  'ttf',
  'eot',
  'onnx',
  'bin',
  'so',
  'dylib',
  'dll',
  'node',
  'map',
  'lock',
  'wasm',
  'class',
  'jar',
]);

/** Exact filenames that are skipped regardless of extension (lockfiles). */
const SKIP_NAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'poetry.lock',
  'cargo.lock',
  'composer.lock',
  'go.sum',
]);

/** Whether a repo-relative path should be ingested for code Q&A. */
export function shouldIngestPath(relPath: string): boolean {
  const parts = relPath.split('/').filter((p) => p !== '');
  if (parts.some((p) => SKIP_DIRS.has(p))) return false;
  const base = parts.length > 0 ? parts[parts.length - 1] : '';
  if (base === undefined || base === '') return false;
  if (SKIP_NAMES.has(base)) return false;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (SKIP_EXT.has(ext)) return false;
  return true;
}
