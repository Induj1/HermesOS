import { describe, expect, it } from 'vitest';

import { topoSort, type GraphNode } from '../src/graph.js';

const node = (id: string, ...dependsOn: string[]): GraphNode => ({ id, dependsOn });

const orderOf = (nodes: readonly GraphNode[]): string[] => {
  const result = topoSort(nodes);
  if (!result.ok) throw new Error(`expected a sort, got ${result.reason}`);
  return result.order.map((n) => n.id);
};

describe('topoSort', () => {
  it('puts dependencies before dependents', () => {
    const order = orderOf([node('c', 'b'), node('b', 'a'), node('a')]);

    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('handles a diamond', () => {
    const order = orderOf([
      node('d', 'b', 'c'),
      node('b', 'a'),
      node('c', 'a'),
      node('a'),
    ]);

    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });

  it('accepts an empty graph', () => {
    expect(orderOf([])).toEqual([]);
  });

  it('keeps independent nodes, in input order', () => {
    expect(orderOf([node('a'), node('b')])).toEqual(['a', 'b']);
  });

  it('reports the cycle path, not just that one exists', () => {
    const result = topoSort([node('a', 'c'), node('b', 'a'), node('c', 'b')]);

    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'cycle') throw new Error('expected a cycle');
    // Starts and ends on the same node, so the loop is readable.
    expect(result.cycle.at(0)).toBe(result.cycle.at(-1));
    expect(result.cycle).toContain('a');
    expect(result.cycle).toContain('b');
    expect(result.cycle).toContain('c');
  });

  it('detects a self-cycle', () => {
    const result = topoSort([node('a', 'a')]);

    expect(result).toMatchObject({ ok: false, reason: 'cycle' });
  });

  it('names both ends of a dangling dependency', () => {
    const result = topoSort([node('a', 'ghost')]);

    expect(result).toMatchObject({
      ok: false,
      reason: 'missing',
      from: 'a',
      missing: 'ghost',
    });
  });

  it('rejects duplicate ids', () => {
    const result = topoSort([node('a'), node('a')]);

    expect(result).toMatchObject({ ok: false, reason: 'duplicate', id: 'a' });
  });
});
