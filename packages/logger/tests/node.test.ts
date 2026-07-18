/**
 * consoleSink — warn/error to stderr, debug/info to stdout.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogRecord } from '../src/logger.js';
import { consoleSink } from '../src/node.js';

const record = (level: LogRecord['level']): LogRecord => ({
  level,
  message: 'm',
  timeMs: 0,
  fields: {},
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('consoleSink', () => {
  it('routes debug and info to stdout', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const sink = consoleSink();
    sink.write(record('debug'));
    sink.write(record('info'));
    expect(out).toHaveBeenCalledTimes(2);
    expect(err).not.toHaveBeenCalled();
    expect(out.mock.calls[0]?.[0]).toContain('"level":"debug"');
    expect(String(out.mock.calls[0]?.[0]).endsWith('\n')).toBe(true);
  });

  it('routes warn and error to stderr', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const sink = consoleSink();
    sink.write(record('warn'));
    sink.write(record('error'));
    expect(err).toHaveBeenCalledTimes(2);
    expect(out).not.toHaveBeenCalled();
  });
});
