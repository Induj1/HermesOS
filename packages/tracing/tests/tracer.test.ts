/**
 * The tracer — root vs child identity, options, and withSpan.
 */

import { TestClock } from '@hermes/kernel';
import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '../src/span.js';
import { sequentialIdGenerator } from '../src/ids.js';
import { Tracer } from '../src/tracer.js';

function tracer(
  clock: TestClock,
  exporter: InMemorySpanExporter,
  sampled?: boolean,
): Tracer {
  return new Tracer({
    clock,
    ids: sequentialIdGenerator(),
    exporter,
    ...(sampled === undefined ? {} : { sampled }),
  });
}

describe('startSpan', () => {
  it('starts a root span with a fresh trace id and no parent', () => {
    const clock = new TestClock(10);
    const exporter = new InMemorySpanExporter();
    const span = tracer(clock, exporter).startSpan('root', { attributes: { a: 1 } });
    const ctx = span.context();
    expect(ctx.traceId).toBe('0'.repeat(31) + '1');
    expect(ctx.spanId).toBe('0'.repeat(15) + '1');
    expect(ctx.sampled).toBe(true);
    span.end();
    expect(exporter.spans[0]?.parentSpanId).toBeUndefined();
    expect(exporter.spans[0]?.startMs).toBe(10);
    expect(exporter.spans[0]?.attributes).toEqual({ a: 1 });
  });

  it('starts a child span inheriting trace id and sampled, recording the parent', () => {
    const clock = new TestClock(0);
    const exporter = new InMemorySpanExporter();
    const t = tracer(clock, exporter);
    const parent = t.startSpan('parent');
    const child = t.startSpan('child', { parent: parent.context() });
    expect(child.context().traceId).toBe(parent.context().traceId);
    expect(child.context().spanId).not.toBe(parent.context().spanId);
    child.end();
    expect(exporter.spans[0]?.parentSpanId).toBe(parent.context().spanId);
  });

  it('inherits an unsampled parent flag', () => {
    const clock = new TestClock(0);
    const exporter = new InMemorySpanExporter();
    const t = tracer(clock, exporter);
    const child = t.startSpan('child', {
      parent: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: false },
    });
    expect(child.context().sampled).toBe(false);
  });

  it('honours the tracer default sampled=false for roots', () => {
    const clock = new TestClock(0);
    const exporter = new InMemorySpanExporter();
    const span = tracer(clock, exporter, false).startSpan('root');
    expect(span.context().sampled).toBe(false);
  });

  it('honours a start time override', () => {
    const clock = new TestClock(100);
    const exporter = new InMemorySpanExporter();
    tracer(clock, exporter).startSpan('root', { startMs: 5 }).end(9);
    expect(exporter.spans[0]?.startMs).toBe(5);
    expect(exporter.spans[0]?.durationMs).toBe(4);
  });
});

describe('withSpan', () => {
  it('ends the span and returns the value on success', async () => {
    const clock = new TestClock(0);
    const exporter = new InMemorySpanExporter();
    const result = await tracer(clock, exporter).withSpan('op', async (span) => {
      span.setAttribute('k', 'v');
      await clock.advance(5);
      return 42;
    });
    expect(result).toBe(42);
    expect(exporter.spans).toHaveLength(1);
    expect(exporter.spans[0]?.status).toBe('unset');
    expect(exporter.spans[0]?.attributes).toEqual({ k: 'v' });
  });

  it('records an error status, ends, and re-throws', async () => {
    const clock = new TestClock(0);
    const exporter = new InMemorySpanExporter();
    await expect(
      tracer(clock, exporter).withSpan('op', () => {
        throw new Error('kaboom');
      }),
    ).rejects.toThrow('kaboom');
    expect(exporter.spans).toHaveLength(1);
    expect(exporter.spans[0]?.status).toBe('error');
    expect(exporter.spans[0]?.statusMessage).toBe('kaboom');
  });

  it('threads options (a parent context) into the span', async () => {
    const clock = new TestClock(0);
    const exporter = new InMemorySpanExporter();
    const parent = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true };
    await tracer(clock, exporter).withSpan('child', (span) => span.context().traceId, {
      parent,
    });
    expect(exporter.spans[0]?.parentSpanId).toBe('b'.repeat(16));
    expect(exporter.spans[0]?.context.traceId).toBe('a'.repeat(32));
  });

  it('stringifies a non-Error throw for the status message', async () => {
    const clock = new TestClock(0);
    const exporter = new InMemorySpanExporter();
    await expect(
      tracer(clock, exporter).withSpan('op', () => {
        // A non-Error throw, to exercise the String(error) branch of messageOf.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'nope';
      }),
    ).rejects.toBe('nope');
    expect(exporter.spans[0]?.statusMessage).toBe('nope');
  });
});
