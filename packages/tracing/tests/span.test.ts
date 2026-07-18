/**
 * Spans — recording, ending (with export + duration), and post-end no-ops.
 */

import { TestClock } from '@hermes/kernel';
import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter, Span } from '../src/span.js';
import { sequentialIdGenerator } from '../src/ids.js';

function makeSpan(clock: TestClock, exporter: InMemorySpanExporter, startMs = 0): Span {
  const ids = sequentialIdGenerator();
  return new Span({
    name: 'work',
    context: { traceId: ids.traceId(), spanId: ids.spanId(), sampled: true },
    parentSpanId: undefined,
    startMs,
    clock,
    exporter,
    attributes: { initial: 'a' },
  });
}

describe('recording and end', () => {
  it('captures attributes, events, status, and duration on end', () => {
    const clock = new TestClock(100);
    const exporter = new InMemorySpanExporter();
    const span = makeSpan(clock, exporter, 100);

    span
      .setAttribute('http.method', 'GET')
      .setAttributes({ 'http.status': 200, cached: false })
      .addEvent('cache.miss', { key: 'k1' })
      .setStatus('ok');

    span.end(150);

    expect(exporter.spans).toHaveLength(1);
    const finished = exporter.spans[0];
    expect(finished?.name).toBe('work');
    expect(finished?.startMs).toBe(100);
    expect(finished?.endMs).toBe(150);
    expect(finished?.durationMs).toBe(50);
    expect(finished?.attributes).toEqual({
      initial: 'a',
      'http.method': 'GET',
      'http.status': 200,
      cached: false,
    });
    expect(finished?.events[0]).toEqual({
      name: 'cache.miss',
      timeMs: 100,
      attributes: { key: 'k1' },
    });
    expect(finished?.status).toBe('ok');
    expect(finished?.parentSpanId).toBeUndefined();
  });

  it('defaults endMs to the clock and records the status message', async () => {
    const clock = new TestClock(0);
    const exporter = new InMemorySpanExporter();
    const span = makeSpan(clock, exporter, 0);
    await clock.advance(30);
    span.setStatus('error', 'boom').end();
    expect(exporter.spans[0]?.endMs).toBe(30);
    expect(exporter.spans[0]?.durationMs).toBe(30);
    expect(exporter.spans[0]?.statusMessage).toBe('boom');
  });

  it('is idempotent — a second end() does not export again', () => {
    const clock = new TestClock(0);
    const exporter = new InMemorySpanExporter();
    const span = makeSpan(clock, exporter);
    span.end();
    span.end();
    expect(exporter.spans).toHaveLength(1);
    expect(span.ended).toBe(true);
  });

  it('ignores recording after end', () => {
    const clock = new TestClock(0);
    const exporter = new InMemorySpanExporter();
    const span = makeSpan(clock, exporter);
    span.end();
    span
      .setName('late')
      .setAttribute('late', 'x')
      .setAttributes({ also: 'y' })
      .addEvent('late-event')
      .setStatus('error', 'ignored');
    const finished = exporter.spans[0];
    expect(finished?.name).toBe('work');
    expect(finished?.attributes).toEqual({ initial: 'a' });
    expect(finished?.events).toHaveLength(0);
    expect(finished?.status).toBe('unset');
  });

  it('renames before end', () => {
    const clock = new TestClock(0);
    const exporter = new InMemorySpanExporter();
    const span = makeSpan(clock, exporter);
    span.setName('GET /missions/:id').end();
    expect(exporter.spans[0]?.name).toBe('GET /missions/:id');
  });

  it('exposes its context', () => {
    const clock = new TestClock(0);
    const exporter = new InMemorySpanExporter();
    const span = makeSpan(clock, exporter);
    expect(span.context().sampled).toBe(true);
  });
});

describe('InMemorySpanExporter', () => {
  it('resets its buffer', () => {
    const clock = new TestClock(0);
    const exporter = new InMemorySpanExporter();
    makeSpan(clock, exporter).end();
    expect(exporter.spans).toHaveLength(1);
    exporter.reset();
    expect(exporter.spans).toHaveLength(0);
  });
});
