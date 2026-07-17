/**
 * The tool selectors that ship with the framework.
 *
 * Three, and each is a real policy rather than a variation on a theme. What is
 * absent is the interesting part: there is no embedding-backed selector, because
 * `ToolSelectionStrategy.select` is synchronous on purpose (see the port) — a
 * selector that embedded the request would make *every turn of every agent* wait
 * on a model call, and hiding that behind an interface everyone calls by default
 * is how a system gets slow in a way nobody can find.
 */

import type { AgentRequest } from './model.js';
import type { AvailableCapability } from './ports/agent-executor.js';
import type { ToolSelectionStrategy } from './ports/tool-selection.js';

/**
 * Offer everything.
 *
 * The default, and honestly the wrong one at scale — a model handed sixty tools
 * picks worse than the same model handed six, and pays for the sixty on every
 * turn. It is the default anyway because the alternative is a framework that
 * refuses to run until a host has made a decision it has no information to make
 * yet. A deterministic agent ignores the list entirely, so the default costs it
 * nothing; a model-backed one should say otherwise. RFC-0005 §7.2 records the
 * tension rather than pretending it away.
 */
export class AllTools implements ToolSelectionStrategy {
  readonly name = 'all';

  select(
    _request: AgentRequest,
    available: readonly AvailableCapability[],
  ): readonly AvailableCapability[] {
    return available;
  }
}

/**
 * Offer nothing.
 *
 * Not a null object — a real policy, and the right one for an agent that must
 * answer from the prompt and memory alone: a summariser, a classifier, a
 * rewriter. It is also the safe choice for an agent handling untrusted input,
 * because a model that cannot see a tool cannot be talked into asking for it.
 */
export class NoTools implements ToolSelectionStrategy {
  readonly name = 'none';

  select(): readonly AvailableCapability[] {
    return [];
  }
}

export interface NamedToolsOptions {
  /** Offer exactly these, in this order. Names that do not exist are ignored. */
  readonly names?: readonly string[];
  /** Offer anything carrying at least one of these tags. */
  readonly tags?: readonly string[];
  readonly name?: string;
}

/**
 * Offer a declared set, by name or by tag.
 *
 * The policy that covers most real agents: a host knows which handful of tools a
 * summariser needs, and saying so once is better than a model rediscovering it
 * every turn.
 *
 * Unknown names are **ignored rather than rejected**, and it is worth saying why,
 * because the opposite is defensible. Capabilities arrive from plugins at
 * runtime, so an agent declared at module load legitimately names a tool that is
 * not registered yet — and throwing would make agent construction depend on
 * plugin load order, which is exactly the race the kernel's registry exists to
 * prevent. The failure mode of ignoring is an agent that cannot see a tool it
 * expected, which shows up in its decisions; the failure mode of throwing is a
 * host that will not boot.
 */
export class NamedTools implements ToolSelectionStrategy {
  readonly name: string;
  readonly #names: ReadonlySet<string>;
  readonly #tags: ReadonlySet<string>;

  constructor(options: NamedToolsOptions) {
    this.name = options.name ?? 'named';
    this.#names = new Set(options.names ?? []);
    this.#tags = new Set(options.tags ?? []);
  }

  select(
    _request: AgentRequest,
    available: readonly AvailableCapability[],
  ): readonly AvailableCapability[] {
    // Declaring neither names nor tags selects nothing, not everything. The same
    // rule as `RuleMatcher` (RFC-0003 §7.5, inherited): an empty declaration is
    // almost certainly a mistake, and reading it as "everything" would silently
    // widen an agent's reach — the direction that fails open.
    if (this.#names.size === 0 && this.#tags.size === 0) return [];

    return available.filter(
      (capability) =>
        this.#names.has(capability.name) ||
        (capability.tags ?? []).some((tag) => this.#tags.has(tag)),
    );
  }
}
