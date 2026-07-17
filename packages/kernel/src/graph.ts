/**
 * Dependency-graph sorting, used twice: to order a mission's tasks and to order
 * plugin setup. Both are "these things depend on those things, reject cycles",
 * so both call the same function.
 *
 * Errors are returned, not thrown — the two callers want to report failures very
 * differently (a mission collects issues for a validation error, the runtime
 * throws immediately), and a result type lets each decide.
 */

export interface GraphNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

export type TopoResult<T> =
  | { readonly ok: true; readonly order: readonly T[] }
  | { readonly ok: false; readonly reason: 'duplicate'; readonly id: string }
  | {
      readonly ok: false;
      readonly reason: 'missing';
      readonly from: string;
      readonly missing: string;
    }
  | { readonly ok: false; readonly reason: 'cycle'; readonly cycle: readonly string[] };

/**
 * Depth-first topological sort. Dependencies come before dependents.
 *
 * DFS rather than Kahn's algorithm because a failure here is a human's authoring
 * mistake, and DFS's colour marking hands back the actual cycle path
 * (`a -> b -> a`) instead of just "a cycle exists somewhere".
 */
export function topoSort<T extends GraphNode>(nodes: readonly T[]): TopoResult<T> {
  const byId = new Map<string, T>();
  for (const node of nodes) {
    if (byId.has(node.id)) return { ok: false, reason: 'duplicate', id: node.id };
    byId.set(node.id, node);
  }

  const order: T[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];

  const visit = (node: T): TopoResult<T> | null => {
    const seen = state.get(node.id);
    if (seen === 'done') return null;
    if (seen === 'visiting') {
      const start = path.indexOf(node.id);
      return { ok: false, reason: 'cycle', cycle: [...path.slice(start), node.id] };
    }

    state.set(node.id, 'visiting');
    path.push(node.id);
    for (const depId of node.dependsOn) {
      const dep = byId.get(depId);
      if (!dep) return { ok: false, reason: 'missing', from: node.id, missing: depId };
      const failure = visit(dep);
      if (failure) return failure;
    }
    path.pop();
    state.set(node.id, 'done');
    order.push(node);
    return null;
  };

  for (const node of nodes) {
    const failure = visit(node);
    if (failure) return failure;
  }
  return { ok: true, order };
}
