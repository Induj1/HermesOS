/**
 * The capability port: what can this system actually do?
 *
 * ## Why this exists at all
 *
 * The kernel validates a mission's *graph* but never its *handlers*.
 * `Runtime.createMission` calls `Mission.create`, which checks names, cycles, and
 * attempt counts — and nothing else. Handler resolution happens later, in
 * `Runtime.#execute`, at dispatch:
 *
 * ```ts
 * const agent = this.#agents.get(task.handler.name);
 * if (!agent) throw new NotFoundError('agent', task.handler.name);
 * ```
 *
 * So a mission naming a tool that does not exist is *valid*. It is accepted,
 * submitted, and scheduled. Its upstream tasks run — sending the email, making
 * the commit, spending the money — and only then does the typo surface, as a
 * `NotFoundError` from inside the scheduler, with half the work done and no way
 * to undo it.
 *
 * That is not a kernel bug. The kernel is a scheduler and resolves handlers at
 * the last moment on purpose, because a plugin may register capabilities right up
 * until `start()`. But it leaves a real gap, and closing it is the single most
 * valuable thing the planner does. `PlanValidator` uses this port to answer "does
 * every step name something that exists?" *before* anything runs.
 *
 * `tests/kernel-gap.test.ts` pins the gap itself, so that if the kernel ever
 * closes it, we find out and can delete this justification.
 */

import type { Capability, CapabilityKind } from '../model.js';

export interface CapabilityCatalog {
  /** Everything available, in a stable order. What a strategy offers a model. */
  list(): readonly Capability[];
  /** By name, regardless of kind. */
  find(name: string): Capability | undefined;
  /** Narrower than `find`: a tool and an agent may share a name. */
  has(name: string, kind?: CapabilityKind): boolean;
}

/**
 * A fixed catalog.
 *
 * For tests, for planning offline against a declared manifest, and for the case
 * where a host wants to plan before a runtime exists — which is the normal case
 * when a plan is reviewed by a human before anything is started.
 */
export class StaticCapabilityCatalog implements CapabilityCatalog {
  readonly #byKey: ReadonlyMap<string, Capability>;
  readonly #all: readonly Capability[];

  constructor(capabilities: readonly Capability[]) {
    // Keyed by kind AND name, because the kernel keeps two registries and lets a
    // tool and an agent share a name without conflict (`Registry` is per-kind).
    // A name-only key here would make one shadow the other and turn a legal
    // configuration into a silent misroute.
    this.#byKey = new Map(capabilities.map((c) => [key(c.kind, c.name), c]));
    this.#all = [...capabilities];
  }

  list(): readonly Capability[] {
    return this.#all;
  }

  find(name: string): Capability | undefined {
    return this.#all.find((capability) => capability.name === name);
  }

  has(name: string, kind?: CapabilityKind): boolean {
    if (kind !== undefined) return this.#byKey.has(key(kind, name));
    return this.#all.some((capability) => capability.name === name);
  }
}

/**
 * The shape of a kernel `Runtime`, as the planner needs it.
 *
 * Structural, not an import of `Runtime`. Two reasons, and the second is the one
 * that matters:
 *
 *   1. The planner needs two read-only getters, not a scheduler. Depending on the
 *      whole class would let a future change here reach for `runtime.run()`, and
 *      a planner that can start missions is no longer a planner.
 *   2. Dependencies point inward. This port is defined by the planner, in the
 *      planner's terms, and the kernel satisfies it by coincidence of shape —
 *      which is exactly Dependency Inversion. The kernel does not know it is
 *      being adapted, and never will.
 */
export interface CapabilitySource {
  readonly tools: {
    list(): readonly { readonly name: string; readonly description: string }[];
  };
  readonly agents: {
    list(): readonly {
      readonly name: string;
      readonly description: string;
      readonly capabilities?: readonly string[];
    }[];
  };
}

/**
 * A catalog backed by a live kernel runtime.
 *
 * Reads through on every call rather than snapshotting. A runtime's registries
 * are fixed once it is running (capabilities enter only through plugins, at
 * setup), so the cost is a `Map` walk over a handful of entries — and reading
 * through means a catalog built before `start()` cannot go stale, which a
 * snapshot silently would.
 */
export class RuntimeCapabilityCatalog implements CapabilityCatalog {
  readonly #source: CapabilitySource;

  constructor(source: CapabilitySource) {
    this.#source = source;
  }

  list(): readonly Capability[] {
    return [
      ...this.#source.tools.list().map((tool): Capability => ({
        kind: 'tool',
        name: tool.name,
        description: tool.description,
        tags: [],
      })),
      ...this.#source.agents.list().map((agent): Capability => ({
        kind: 'agent',
        name: agent.name,
        description: agent.description,
        // The kernel carries `Agent.capabilities` as "free-form capability
        // tags... for routing layers built above it" (kernel agent.ts). This is
        // that layer; this is where they land.
        tags: agent.capabilities ?? [],
      })),
    ];
  }

  find(name: string): Capability | undefined {
    return this.list().find((capability) => capability.name === name);
  }

  has(name: string, kind?: CapabilityKind): boolean {
    return this.list().some(
      (capability) =>
        capability.name === name && (kind === undefined || capability.kind === kind),
    );
  }
}

/**
 * Read from several catalogs as one.
 *
 * Earlier catalogs win on conflict, so a host can layer a live runtime over a
 * declared manifest — the pattern for "plan against what is registered, plus what
 * we know a not-yet-loaded plugin will register".
 */
export class CompositeCapabilityCatalog implements CapabilityCatalog {
  readonly #catalogs: readonly CapabilityCatalog[];

  constructor(catalogs: readonly CapabilityCatalog[]) {
    this.#catalogs = catalogs;
  }

  list(): readonly Capability[] {
    const seen = new Map<string, Capability>();
    for (const catalog of this.#catalogs) {
      for (const capability of catalog.list()) {
        const id = key(capability.kind, capability.name);
        // First writer wins: `Map.set` would let a later catalog overwrite an
        // earlier one, inverting the documented precedence.
        if (!seen.has(id)) seen.set(id, capability);
      }
    }
    return [...seen.values()];
  }

  find(name: string): Capability | undefined {
    return this.list().find((capability) => capability.name === name);
  }

  has(name: string, kind?: CapabilityKind): boolean {
    return this.#catalogs.some((catalog) => catalog.has(name, kind));
  }
}

function key(kind: CapabilityKind, name: string): string {
  return `${kind}:${name}`;
}
