/**
 * Trace correlation — stamping trace/span ids onto a logger.
 */

import { TestClock } from '@hermes/kernel';
import { describe, expect, it } from 'vitest';
import { StructuredLogger } from '../src/logger.js';
import { MemorySink } from '../src/sink.js';
import { traceFields, withTrace } from '../src/trace.js';

const ctx = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true };

describe('traceFields', () => {
  it('extracts the trace and span ids', () => {
    expect(traceFields(ctx)).toEqual({
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
    });
  });
});

describe('withTrace', () => {
  it('binds trace/span ids onto every record', () => {
    const sink = new MemorySink();
    const base = new StructuredLogger({ sink, clock: new TestClock() });
    const traced = withTrace(base.child({ requestId: 'r1' }), ctx);
    traced.info('handled', { route: '/m' });
    expect(sink.records[0]?.fields).toEqual({
      requestId: 'r1',
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      route: '/m',
    });
  });
});
