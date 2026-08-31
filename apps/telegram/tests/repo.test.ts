import { describe, expect, it } from 'vitest';
import { shouldIngestPath } from '../src/repo.js';

describe('shouldIngestPath', () => {
  it('ingests source files', () => {
    for (const p of [
      'src/main.ts',
      'apps/web/index.tsx',
      'README.md',
      'lib/util.py',
      'go/server.go',
      'Dockerfile',
    ]) {
      expect(shouldIngestPath(p)).toBe(true);
    }
  });

  it('skips vendored/generated dirs, lockfiles, and binaries', () => {
    for (const p of [
      'node_modules/react/index.js',
      '.git/config',
      'dist/main.js',
      'coverage/index.html',
      '.venv-sd/bin/python',
      'package-lock.json',
      'pnpm-lock.yaml',
      'assets/logo.png',
      'fonts/x.woff2',
      'model.onnx',
      'build/out.map',
    ]) {
      expect(shouldIngestPath(p)).toBe(false);
    }
  });

  it('handles empty and dotfile paths', () => {
    expect(shouldIngestPath('')).toBe(false);
    expect(shouldIngestPath('.env')).toBe(true);
  });
});
