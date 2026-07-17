/**
 * The registry — get-or-create, snapshot, and Prometheus rendering.
 */

import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../src/registry.js';

describe('get-or-create', () => {
  it('returns the same instrument for the same name', () => {
    const r = new MetricsRegistry();
    const a = r.counter('reqs');
    const b = r.counter('reqs');
    expect(a).toBe(b);
    a.inc();
    expect(b.get()).toBe(1);
  });

  it('throws when a name is reused with a different type', () => {
    const r = new MetricsRegistry();
    r.counter('x');
    expect(() => r.gauge('x')).toThrow(/already registered as a counter/);
  });
});

describe('snapshot', () => {
  it('reports counters, gauges, and histograms', () => {
    const r = new MetricsRegistry();
    r.counter('c', 'a counter').inc({}, 3);
    r.gauge('g').set(5);
    r.histogram('h', [1, 2], 'a histogram').observe(1.5);

    const snap = r.snapshot();
    expect(snap.map((s) => s.type).sort()).toEqual(['counter', 'gauge', 'histogram']);
    const counter = snap.find((s) => s.name === 'c');
    expect(counter?.samples).toEqual([{ labels: {}, value: 3 }]);
    const histogram = snap.find((s) => s.name === 'h');
    expect(histogram?.histograms[0]?.count).toBe(1);
  });
});

describe('toPrometheus', () => {
  it('renders counters and gauges with HELP and TYPE', () => {
    const r = new MetricsRegistry();
    r.counter('http_requests_total', 'HTTP requests', ['method']).inc(
      { method: 'GET' },
      2,
    );
    r.gauge('inflight', 'in flight').set(3);

    const text = r.toPrometheus();
    expect(text).toContain('# HELP http_requests_total HTTP requests');
    expect(text).toContain('# TYPE http_requests_total counter');
    expect(text).toContain('http_requests_total{method="GET"} 2');
    expect(text).toContain('# TYPE inflight gauge');
    expect(text).toContain('inflight 3');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('renders a histogram with buckets, +Inf, sum, and count', () => {
    const r = new MetricsRegistry();
    const h = r.histogram('latency', [1, 5], 'latency', ['route']);
    h.observe(0.5, { route: '/a' });
    h.observe(3, { route: '/a' });

    const text = r.toPrometheus();
    expect(text).toContain('latency_bucket{route="/a",le="1"} 1');
    expect(text).toContain('latency_bucket{route="/a",le="5"} 2');
    expect(text).toContain('latency_bucket{route="/a",le="+Inf"} 2');
    expect(text).toContain('latency_sum{route="/a"} 3.5');
    expect(text).toContain('latency_count{route="/a"} 2');
  });

  it('omits HELP when empty and returns empty for an empty registry', () => {
    const r = new MetricsRegistry();
    r.counter('x').inc();
    expect(r.toPrometheus()).not.toContain('# HELP');
    expect(new MetricsRegistry().toPrometheus()).toBe('');
  });

  it('escapes special characters in label values', () => {
    const r = new MetricsRegistry();
    r.counter('c', '', ['path']).inc({ path: 'a"b\\c' });
    expect(r.toPrometheus()).toContain('c{path="a\\"b\\\\c"} 1');
  });
});
