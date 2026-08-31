import { FakeShellExecutor } from '@hermes/tools-shell';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DENY, guardedShell } from '../src/shell-guard.js';

const ok = FakeShellExecutor.succeedingWith('done');

describe('guardedShell', () => {
  it('allows a safe command through', async () => {
    const guarded = guardedShell(ok);
    const result = await guarded.run('ls', ['-la'], {});
    expect(result.stdout).toBe('done');
  });

  it('refuses dangerous commands, including danger hidden in node -e', async () => {
    const guarded = guardedShell(ok);
    await expect(guarded.run('rm', ['-rf', '/'], {})).rejects.toThrow(/safety guard/);
    await expect(guarded.run('sudo', ['reboot'], {})).rejects.toThrow(/safety guard/);
    await expect(
      guarded.run('node', ['-e', "require('child_process').execSync('rm -rf x')"], {}),
    ).rejects.toThrow(/safety guard/);
    await expect(guarded.run('git', ['push', '--force'], {})).rejects.toThrow(
      /safety guard/,
    );
  });

  it('accepts custom deny patterns', async () => {
    const guarded = guardedShell(ok, [/\bsecret\b/i]);
    await expect(guarded.run('echo', ['secret'], {})).rejects.toThrow(/safety guard/);
    await expect(guarded.run('rm', ['-rf', '/'], {})).resolves.toBeTruthy(); // not in custom list
  });

  it('exports sensible defaults', () => {
    expect(DEFAULT_DENY.some((p) => p.test('sudo rm -rf /'))).toBe(true);
  });
});
