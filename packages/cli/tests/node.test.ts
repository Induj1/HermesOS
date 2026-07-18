/**
 * The process adapter — processIO routing and runCli wiring.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLI } from '../src/cli.js';
import { processIO, runCli } from '../src/node.js';

const savedExitCode = process.exitCode;
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = savedExitCode;
});

describe('processIO', () => {
  it('routes write to stdout and writeError to stderr', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const io = processIO();
    io.write('hi');
    io.writeError('oops');
    expect(out).toHaveBeenCalledWith('hi');
    expect(err).toHaveBeenCalledWith('oops');
  });
});

describe('runCli', () => {
  const cli = new CLI({ name: 'hermes', version: '9.9.9' });

  it('sets process.exitCode from the run result and uses the passed argv', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runCli(cli, ['--version']);
    expect(process.exitCode).toBe(0);
  });

  it('reflects a failure exit code', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await runCli(cli, ['unknown-command']);
    expect(process.exitCode).toBe(1);
  });

  it('defaults argv to process.argv.slice(2)', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const original = process.argv;
    process.argv = ['node', 'script', '--version'];
    try {
      await runCli(cli);
      expect(process.exitCode).toBe(0);
    } finally {
      process.argv = original;
    }
  });
});
