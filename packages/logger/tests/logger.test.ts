/**
 * StructuredLogger — levels, field merging, child context, timestamps.
 */

import { TestClock } from '@hermes/kernel';
import { describe, expect, it } from 'vitest';
import { StructuredLogger, isLevelEnabled } from '../src/logger.js';
import { MemorySink } from '../src/sink.js';

function make(level?: 'debug' | 'info' | 'warn' | 'error', startAt = 0) {
  const sink = new MemorySink();
  const clock = new TestClock(startAt);
  const logger = new StructuredLogger({
    sink,
    clock,
    ...(level === undefined ? {} : { level }),
  });
  return { sink, clock, logger };
}

describe('levels', () => {
  it('defaults to info and drops debug', () => {
    const { sink, logger } = make();
    expect(logger.level).toBe('info');
    logger.debug('noise');
    logger.info('kept');
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.message).toBe('kept');
  });

  it('emits every level at or above the threshold', () => {
    const { sink, logger } = make('warn');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(sink.records.map((r) => r.level)).toEqual(['warn', 'error']);
  });

  it('emits all four at debug', () => {
    const { sink, logger } = make('debug');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(sink.records).toHaveLength(4);
  });
});

describe('fields and timestamps', () => {
  it('stamps the clock time onto each record', () => {
    const { sink, clock, logger } = make('info', 1000);
    logger.info('a');
    void clock.advance(50);
    logger.info('b');
    expect(sink.records.map((r) => r.timeMs)).toEqual([1000, 1050]);
  });

  it('uses bound fields alone when no per-call fields are given', () => {
    const sink = new MemorySink();
    const logger = new StructuredLogger({
      sink,
      clock: new TestClock(),
      fields: { service: 'api' },
    });
    logger.info('hi');
    expect(sink.records[0]?.fields).toEqual({ service: 'api' });
  });

  it('merges per-call fields over bound fields', () => {
    const sink = new MemorySink();
    const logger = new StructuredLogger({
      sink,
      clock: new TestClock(),
      fields: { service: 'api', env: 'prod' },
    });
    logger.info('hi', { env: 'staging', route: '/x' });
    expect(sink.records[0]?.fields).toEqual({
      service: 'api',
      env: 'staging',
      route: '/x',
    });
  });
});

describe('child', () => {
  it('binds fields onto every downstream record and inherits level/sink', () => {
    const { sink, logger } = make('info');
    const child = logger.child({ requestId: 'r1' });
    child.info('handling', { route: '/m' });
    child.debug('dropped');
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.fields).toEqual({ requestId: 'r1', route: '/m' });
  });

  it('merges parent and child bound fields, child winning', () => {
    const sink = new MemorySink();
    const logger = new StructuredLogger({
      sink,
      clock: new TestClock(),
      fields: { a: 1, b: 2 },
    });
    logger.child({ b: 3, c: 4 }).info('x');
    expect(sink.records[0]?.fields).toEqual({ a: 1, b: 3, c: 4 });
  });
});

describe('isLevelEnabled', () => {
  it('reports whether a level clears a threshold', () => {
    expect(isLevelEnabled('debug', 'info')).toBe(false);
    expect(isLevelEnabled('info', 'info')).toBe(true);
    expect(isLevelEnabled('error', 'warn')).toBe(true);
  });
});
