/**
 * Sinks and formatting — JSON line shape, reserved-key safety, redaction.
 */

import { describe, expect, it } from 'vitest';
import type { LogRecord } from '../src/logger.js';
import { MemorySink, formatJsonLine, jsonLinesSink } from '../src/sink.js';

const record = (fields: LogRecord['fields'] = {}): LogRecord => ({
  level: 'info',
  message: 'hello',
  timeMs: 1234,
  fields,
});

const parse = (line: string): Record<string, unknown> =>
  JSON.parse(line) as Record<string, unknown>;

describe('formatJsonLine', () => {
  it('renders core keys then fields', () => {
    const line = formatJsonLine(record({ port: 3000, ok: true }));
    expect(JSON.parse(line)).toEqual({
      time: 1234,
      level: 'info',
      msg: 'hello',
      port: 3000,
      ok: true,
    });
  });

  it('drops fields that would shadow a core key', () => {
    const line = formatJsonLine(record({ time: 9, level: 'x', msg: 'y', keep: 1 }));
    expect(JSON.parse(line)).toEqual({
      time: 1234,
      level: 'info',
      msg: 'hello',
      keep: 1,
    });
  });

  it('redacts a Secret-like field via its toJSON', () => {
    const secretLike = { toJSON: () => '[redacted]' };
    const line = formatJsonLine(record({ apiKey: secretLike }));
    expect(parse(line)['apiKey']).toBe('[redacted]');
    expect(line).not.toContain('sk-');
  });
});

describe('MemorySink', () => {
  it('collects records, renders lines, and resets', () => {
    const sink = new MemorySink();
    sink.write(record({ n: 1 }));
    sink.write(record({ n: 2 }));
    expect(sink.records).toHaveLength(2);
    expect(sink.lines().map((l) => parse(l)['n'])).toEqual([1, 2]);
    sink.reset();
    expect(sink.records).toHaveLength(0);
  });
});

describe('jsonLinesSink', () => {
  it('writes a formatted line through the injected writer', () => {
    const written: string[] = [];
    const sink = jsonLinesSink((line) => written.push(line));
    sink.write(record({ a: 1 }));
    expect(written).toHaveLength(1);
    expect(parse(written[0] ?? '')['a']).toBe(1);
  });
});
