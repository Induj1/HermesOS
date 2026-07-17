/**
 * Counter, Gauge, and Histogram instruments with labels.
 */

import { describe, expect, it } from 'vitest';
import { Counter, Gauge, Histogram } from '../src/metrics.js';

describe('Counter', () => {
  it('increments and reads per label set', () => {
    const c = new Counter('reqs', 'requests', ['status']);
    c.inc({ status: '200' });
    c.inc({ status: '200' }, 4);
    c.inc({ status: '500' });
    expect(c.get({ status: '200' })).toBe(5);
    expect(c.get({ status: '500' })).toBe(1);
    expect(c.get({ status: '404' })).toBe(0);
  });

  it('works label-less', () => {
    const c = new Counter('total', '', []);
    c.inc();
    c.inc();
    expect(c.get()).toBe(2);
  });

  it('refuses a negative delta', () => {
    expect(() => {
      new Counter('c', '', []).inc({}, -1);
    }).toThrow(/cannot decrease/);
  });

  it('rejects an undeclared label', () => {
    expect(() => {
      new Counter('c', '', ['a']).inc({ b: '1' });
    }).toThrow(/no label "b"/);
  });

  it('treats sorted label sets as one series', () => {
    const c = new Counter('c', '', ['a', 'b']);
    c.inc({ a: '1', b: '2' });
    c.inc({ b: '2', a: '1' });
    expect(c.samples()).toHaveLength(1);
    expect(c.get({ a: '1', b: '2' })).toBe(2);
  });

  it('defaults an omitted declared label to empty', () => {
    const c = new Counter('c', '', ['a', 'b']);
    c.inc({ a: '1' }); // b omitted → ''
    expect(c.samples()).toEqual([{ labels: { a: '1', b: '' }, value: 1 }]);
    expect(c.get({ a: '1' })).toBe(1);
  });
});

describe('Gauge', () => {
  it('sets, incs, and decs', () => {
    const g = new Gauge('inflight', '', []);
    g.set(5);
    g.inc();
    g.dec(2);
    expect(g.get()).toBe(4);
  });

  it('tracks per label set', () => {
    const g = new Gauge('depth', '', ['queue']);
    g.set(3, { queue: 'a' });
    g.inc(1, { queue: 'b' });
    expect(g.get({ queue: 'a' })).toBe(3);
    expect(g.get({ queue: 'b' })).toBe(1);
    expect(g.samples()).toHaveLength(2);
  });
});

describe('Histogram', () => {
  it('counts observations into cumulative buckets', () => {
    const h = new Histogram('latency', '', [1, 5, 10], []);
    h.observe(0.5);
    h.observe(3);
    h.observe(7);
    h.observe(20); // beyond the last bucket
    const [sample] = h.histograms();
    expect(sample?.count).toBe(4);
    expect(sample?.sum).toBe(30.5);
    // le=1: {0.5}; le=5: {0.5,3}; le=10: {0.5,3,7}
    expect(sample?.buckets).toEqual([
      { le: 1, count: 1 },
      { le: 5, count: 2 },
      { le: 10, count: 3 },
    ]);
  });

  it('sorts buckets ascending regardless of input order', () => {
    const h = new Histogram('h', '', [10, 1, 5], []);
    h.observe(2);
    expect(h.histograms()[0]?.buckets.map((b) => b.le)).toEqual([1, 5, 10]);
  });

  it('tracks distributions per label set', () => {
    const h = new Histogram('h', '', [1], ['route']);
    h.observe(0.5, { route: '/a' });
    h.observe(2, { route: '/b' });
    expect(h.histograms()).toHaveLength(2);
  });

  it('defaults an omitted label and accumulates into an existing series', () => {
    const h = new Histogram('h', '', [1, 5], ['route']);
    h.observe(0.5); // route omitted → ''
    h.observe(3); // same (empty) series again
    const [sample] = h.histograms();
    expect(sample?.labels).toEqual({ route: '' });
    expect(sample?.count).toBe(2);
    expect(sample?.buckets).toEqual([
      { le: 1, count: 1 },
      { le: 5, count: 2 },
    ]);
  });
});
