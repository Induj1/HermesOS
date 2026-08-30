/**
 * Discovery — reading a tool's metadata back out.
 *
 * This is where the gap in `tool.ts` actually closes. A `HermesTool` carries its
 * schema and tags through the kernel's registry untouched; this reads them back
 * and renders them into the two vocabularies that need them:
 *
 * - `@hermes/model`'s `ToolDefinition` — what a model is told.
 * - `@hermes/agent`'s `AvailableCapability` — what a reasoner may ask for.
 *
 * ## Why this package does not import `@hermes/agent`
 *
 * It would be one line and it is rejected. `@hermes/agent` is a *consumer* of
 * capabilities; a tool package that imported it would make every tool depend on
 * the reasoning framework — the same argument that put the model contracts in
 * their own package (RFC-0005 §4).
 *
 * So {@link describe} returns a shape that is **structurally identical** to
 * `AvailableCapability` without naming it: `{ name, kind, description, parameters,
 * tags }`. A host assigns it straight across with no adapter. That claim spans
 * two packages, so it is pinned by a compile-time assertion in
 * `tests/capability-compatibility.test.ts` — which is why `@hermes/agent` is a
 * **devDependency** here and not a real one. The test needs to see it; the code
 * must not.
 *
 * Same trick, same reason, as `EmbeddingModel` and memory's `EmbeddingProvider`
 * (RFC-0005 §4.2).
 */

import type { ReadonlyRegistry, Tool } from '@hermes/kernel';
import type { ToolDefinition as ModelToolDefinition } from '@hermes/model';
import type { HermesTool } from './tool.js';
import { schemaOf } from './tool.js';
import type { JsonSchema } from './schema.js';
import type { Permission } from './permissions.js';

/**
 * A tool, described.
 *
 * Structurally `@hermes/agent`'s `AvailableCapability`, plus the fields a
 * reasoner has no use for but an operator and a permission layer do.
 */
export interface ToolDescription {
  readonly name: string;
  /** Always `'tool'`. Present so this is assignable to `AvailableCapability`. */
  readonly kind: 'tool';
  readonly description: string;
  /** JSON Schema for the arguments. Absent when the tool declared no schema. */
  readonly parameters?: JsonSchema;
  readonly tags?: readonly string[];
  readonly permissions?: readonly Permission[];
  readonly version?: string;
  readonly deprecated?: string;
  readonly idempotent?: boolean;
  /**
   * Why a person must approve each call, when the tool says one must.
   *
   * Carried separately from the rendered description because the two audiences
   * differ: a model needs it folded into prose to plan around, and an operator
   * building an approval queue needs it as a field they can read without
   * parsing English back out of a paragraph.
   */
  readonly requiresApproval?: string;
}

export interface DescribeOptions {
  /**
   * Fold examples into the description a model reads. Default true.
   *
   * On by default because it is the highest-leverage thing this function does. A
   * model reading one worked example gets a tool's arguments right far more often
   * than one reading a JSON Schema, because an example resolves the ambiguities a
   * schema cannot express — is `path` absolute? is `query` keywords or a
   * sentence? The cost is tokens on every turn, which is why it is a switch.
   */
  readonly examples?: boolean;
  /**
   * Say so in the description when a tool is deprecated. Default true.
   *
   * A model cannot read a `deprecated` field it is never shown. The whole point
   * of deprecating a tool is that the thing choosing it stops choosing it, and
   * the only channel to that is the description.
   */
  readonly deprecation?: boolean;
  /**
   * Say so in the description when a tool needs a person. Default true.
   *
   * The same argument as {@link DescribeOptions.deprecation}: a model cannot act
   * on a field it is never shown, and `ToolDefinition` carries only a name, a
   * description, and parameters. Prose is the one channel to the thing doing the
   * planning.
   *
   * Worth leaving on. A model that does not know a call will block treats the
   * pause as a hang and the denial as its own error, and its usual repair for
   * both is to try again — which is the one response an approval gate is built
   * to make pointless.
   */
  readonly approval?: boolean;
}

/**
 * Describe one tool.
 *
 * Works on any kernel `Tool`. One that did not use this framework degrades to
 * name and description — which is exactly what the kernel already offered, so
 * nothing is lost and nothing is invented. A schema is never fabricated: a tool
 * with no schema is reported with no `parameters`, and a model told nothing is
 * better off than a model told a guess.
 */
export function describe(tool: Tool, options: DescribeOptions = {}): ToolDescription {
  const hermes = tool as HermesTool;
  const parameters = schemaOf(tool);

  return {
    name: tool.name,
    kind: 'tool',
    description: renderDescription(hermes, options),
    ...(parameters === undefined ? {} : { parameters }),
    ...(hermes.tags === undefined ? {} : { tags: hermes.tags }),
    ...(hermes.permissions === undefined ? {} : { permissions: hermes.permissions }),
    ...(hermes.version === undefined ? {} : { version: hermes.version }),
    ...(hermes.deprecated === undefined ? {} : { deprecated: hermes.deprecated }),
    ...(hermes.idempotent === undefined ? {} : { idempotent: hermes.idempotent }),
    ...(hermes.requiresApproval === undefined
      ? {}
      : { requiresApproval: hermes.requiresApproval }),
  };
}

/**
 * What a model is told about a tool.
 *
 * `@hermes/model`'s vocabulary, so it goes straight into `chatWithTools`. The
 * projection is trivial *because* `describe` already did the work — which is the
 * point of having one description with two renderings rather than two
 * descriptions.
 */
export function toModelDefinition(
  tool: Tool,
  options: DescribeOptions = {},
): ModelToolDefinition {
  const described = describe(tool, options);
  return {
    name: described.name,
    description: described.description,
    ...(described.parameters === undefined ? {} : { parameters: described.parameters }),
  };
}

export interface CatalogOptions extends DescribeOptions {
  /** Only tools carrying at least one of these tags. */
  readonly tags?: readonly string[];
  /**
   * Only tools whose declared permissions are all granted.
   *
   * A *filter*, not a check: it decides what a model is **told about**, which is
   * upstream of whether a call is allowed. Both matter and they are different. A
   * model shown a tool it may not use will ask for it, be refused, and spend a
   * turn learning what it could have been told for free — and worse, it now knows
   * the tool exists, which for a hidden capability is exactly what a host was
   * trying to avoid. `assertPermitted` is still the thing that refuses the call.
   */
  readonly granted?: { has(permission: Permission): boolean };
  /** Leave out deprecated tools entirely. Default false — they are described. */
  readonly hideDeprecated?: boolean;
}

/**
 * Describe every tool in a registry.
 *
 * Takes the kernel's `ReadonlyRegistry`, which `Runtime.tools` already is — so a
 * host writes `catalog(runtime.tools)` and this package never touches a
 * `Runtime`. That narrowness is the same call the planner makes with
 * `CapabilitySource` (RFC-0003 §3.1): the wide type carries the ability to run
 * things, and a catalog that could run a tool is not a catalog.
 */
export function catalog(
  tools: ReadonlyRegistry<Tool>,
  options: CatalogOptions = {},
): readonly ToolDescription[] {
  return tools
    .list()
    .map((tool) => describe(tool, options))
    .filter((described) => matches(described, options));
}

function matches(described: ToolDescription, options: CatalogOptions): boolean {
  if (options.hideDeprecated === true && described.deprecated !== undefined)
    return false;

  if (options.tags !== undefined && options.tags.length > 0) {
    const tags = described.tags ?? [];
    if (!options.tags.some((tag) => tags.includes(tag))) return false;
  }

  if (options.granted !== undefined) {
    const required = described.permissions ?? [];
    if (!required.every((permission) => options.granted?.has(permission) === true))
      return false;
  }

  return true;
}

/**
 * Fold the metadata a model can only learn from prose into the description.
 *
 * The model reads one string. Everything it needs to *choose* well has to be in
 * it, because `ToolDefinition` has nowhere else to put it — no `deprecated`, no
 * `examples`, no `version`. This is the one channel.
 */
function renderDescription(tool: HermesTool, options: DescribeOptions): string {
  const parts = [tool.description];

  if (options.deprecation !== false && tool.deprecated !== undefined) {
    // First, not last. A model reading a long description may act on the first
    // sentence, and "do not use this" is the sentence that matters.
    parts.unshift(`DEPRECATED: ${tool.deprecated}`);
  }

  if (options.approval !== false && tool.requiresApproval !== undefined) {
    // Appended rather than prepended, which is the opposite of `deprecated` and
    // deliberate. "Do not use this" changes whether a model should choose the
    // tool at all, so it goes first. This does not: the tool is still the right
    // one, and what changes is what happens when it is called. A model that
    // knows a call will pause can say so, or sequence the risky step last,
    // instead of reporting the eventual denial as a failure it caused.
    parts.push(`Requires human approval before it runs: ${tool.requiresApproval}`);
  }

  if (
    options.examples !== false &&
    tool.examples !== undefined &&
    tool.examples.length > 0
  ) {
    parts.push('Examples:', ...tool.examples.map((example) => renderExample(example)));
  }

  return parts.join('\n');
}

function renderExample(example: ToolExampleLike): string {
  const input = safeJson(example.input);
  const output = example.output === undefined ? undefined : safeJson(example.output);
  return output === undefined
    ? `- ${example.description}: ${input}`
    : `- ${example.description}: ${input} -> ${output}`;
}

interface ToolExampleLike {
  readonly description: string;
  readonly input: unknown;
  readonly output?: unknown;
}

/**
 * Render a value for a prompt, never throwing.
 *
 * An example is documentation. A circular one is an authoring mistake that should
 * show up as a scruffy description, not as a crash that takes down every tool
 * description in the process because one example was wrong.
 */
function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value) as string | undefined;
    return json ?? String(value);
  } catch {
    return '(unserialisable example)';
  }
}
