/**
 * Argument parsing — positionals, options, flags, and the `--` terminator.
 */

import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';

describe('parseArgs', () => {
  it('collects positionals', () => {
    const { positionals } = parseArgs(['a', 'b', 'c']);
    expect(positionals).toEqual(['a', 'b', 'c']);
  });

  it('parses --key=value and --key value options', () => {
    const { options } = parseArgs(['--name=hermes', '--level', 'info']);
    expect(options).toEqual({ name: 'hermes', level: 'info' });
  });

  it('treats --flag as a flag when followed by another option or nothing', () => {
    const a = parseArgs(['--verbose', '--name', 'x']);
    expect(a.flags.has('verbose')).toBe(true);
    expect(a.options).toEqual({ name: 'x' });

    const b = parseArgs(['--verbose']);
    expect(b.flags.has('verbose')).toBe(true);
  });

  it('expands -abc into individual short flags', () => {
    const { flags } = parseArgs(['-abc']);
    expect([...flags].sort()).toEqual(['a', 'b', 'c']);
  });

  it('stops option parsing at -- and treats the rest as positionals', () => {
    const { positionals, options } = parseArgs([
      '--name',
      'x',
      '--',
      '--not-an-option',
      '-y',
    ]);
    expect(options).toEqual({ name: 'x' });
    expect(positionals).toEqual(['--not-an-option', '-y']);
  });

  it('leaves a lone dash as a positional', () => {
    expect(parseArgs(['-']).positionals).toEqual(['-']);
  });

  it('returns empty structures for empty argv', () => {
    const parsed = parseArgs([]);
    expect(parsed.positionals).toEqual([]);
    expect(parsed.options).toEqual({});
    expect(parsed.flags.size).toBe(0);
  });
});
