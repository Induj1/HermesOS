/**
 * Tool authoring — a kernel tool that can describe itself.
 *
 * ## The gap this closes
 *
 * The kernel's `Tool` is name, description, two optional `Validator`s, and
 * `execute`. It has **no parameter schema and no tags**, and `ToolAccess.list()`
 * returns only `{ name, description }`. That is correct for the kernel: it
 * dispatches by name and refuses to know what a payload means (RFC-0001 §2).
 *
 * But it leaves a real hole one layer up. `@hermes/agent`'s `AvailableCapability`
 * declares `parameters` and `tags`, and `LlmReasoner` passes `parameters` straight
 * to a model's `ToolDefinition` — so a model is told a tool *exists* and never
 * what arguments it takes. It guesses. And `NamedTools({ tags: [...] })` selects
 * on tags that a kernel-registered tool has no way to carry, so it matches
 * nothing.
 *
 * `tests/kernel-gap.test.ts` pins both, as a property of the packages below this
 * one — the same move `tests/kernel-gap.test.ts` makes in the planner
 * (RFC-0003 §4). If either ever closes it, this layer should shrink.
 *
 * ## How it closes it, without touching anything frozen
 *
 * A {@link HermesTool} **is** a kernel `Tool` — structurally, assignably,
 * registrably — with extra fields the kernel never reads. That is not a trick;
 * it is the seam the kernel left open and named:
 *
 * > Free-form capability tags. The kernel carries them for routing layers built
 * > above it; it never reads them itself. — kernel `agent.ts`
 *
 * The kernel does that for agents. This does the same for tools, from the
 * outside, with no kernel change: `ctx.registerTool(myHermesTool)` type-checks
 * because a `HermesTool` satisfies `Tool`, and the metadata rides along in the
 * object for {@link describe} to read back.
 */

import { defineTool as defineKernelTool } from '@hermes/kernel';
import type { Tool, ToolContext, Validator } from '@hermes/kernel';
import {
  InvalidDefinitionError,
  InputInvalidError,
  OutputInvalidError,
  toError,
} from './errors.js';
import type { JsonSchema, ToolSchema } from './schema.js';
import type { Permission } from './permissions.js';

/**
 * What a tool says about itself, beyond what the kernel needs.
 *
 * Every field is optional, and that is deliberate: a `HermesTool` with no
 * metadata is exactly a kernel tool, so adopting this framework is never a
 * rewrite. You add what you have.
 */
export interface ToolMetadata {
  /**
   * Free-form routing tags.
   *
   * What `NamedTools({ tags: [...] })` selects on, and the reason it can work at
   * all. Conventionally a domain: `filesystem`, `network`, `git`.
   */
  readonly tags?: readonly string[];
  /**
   * What this tool needs permission to do.
   *
   * Declared, never enforced *here* — see `permissions.ts`. A tool declaring
   * `fs:write` is making a statement about itself that a host can act on; it is
   * not asking this framework to police it.
   */
  readonly permissions?: readonly Permission[];
  /**
   * Semantic version of the tool's *contract*, not its implementation.
   *
   * Bump it when the input or output shape changes, not when a bug is fixed.
   * See §7.3 — nothing enforces this, and the honest reason is recorded there.
   */
  readonly version?: string;
  /**
   * Why this tool is deprecated, and what to use instead.
   *
   * A string rather than a boolean, because "deprecated: true" tells a model
   * nothing it can act on, and a model reading tool descriptions is the main
   * consumer of this field.
   */
  readonly deprecated?: string;
  /**
   * Worked examples. Rendered into a model's tool description by {@link describe}.
   *
   * The highest-leverage field in this interface and the one most likely to be
   * skipped. A model reading one example of a tool's arguments gets them right
   * far more often than one reading a JSON Schema, because an example resolves
   * the ambiguities a schema cannot express — is `path` absolute? is `query` a
   * sentence or keywords?
   */
  readonly examples?: readonly ToolExample[];
  /**
   * Does calling this twice do the same thing as calling it once?
   *
   * Not read by this framework. It is carried for the layer that has to decide
   * whether re-running a step is safe — `RecoveryPolicy.incomplete` (RFC-0004
   * §7.3) and `IncompleteTaskPolicy` (RFC-0003 §7.2) both refuse to guess at
   * exactly this, and both say the caller knows their tools. This is where the
   * caller writes it down.
   */
  readonly idempotent?: boolean;
  /** Anything else. Carried, never interpreted. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ToolExample {
  /** One line on what this example shows. */
  readonly description: string;
  readonly input: unknown;
  /** What it returns. Optional: an example of the *call* is most of the value. */
  readonly output?: unknown;
}

/**
 * A kernel tool that can describe itself.
 *
 * `extends Tool<I, O>` is the whole design. Everything the kernel needs is
 * inherited unchanged; everything else is additive and invisible to it.
 */
export interface HermesTool<TInput = unknown, TOutput = unknown>
  extends Tool<TInput, TOutput>, ToolMetadata {
  /**
   * The input schema, as a {@link ToolSchema} rather than a bare `Validator`.
   *
   * Narrowed from the kernel's `Validator` on purpose: a `ToolSchema` also
   * carries `jsonSchema`, which is what {@link describe} tells a model. A tool
   * with a plain `Validator` (a Zod schema, a hand-written parser) is still a
   * legal `HermesTool` — see {@link defineTool} — it simply has nothing to tell
   * the model, and `describe` says so honestly rather than inventing a schema.
   */
  readonly input?: Validator<TInput>;
  readonly output?: Validator<TOutput>;
}

/**
 * A tool of unknown shape, for heterogeneous storage.
 *
 * The kernel's `AnyTool` with metadata, and it exists for exactly the reason the
 * kernel's does: a list of tools is heterogeneous, and `unknown` rather than
 * `any` keeps the call site honest instead of quietly disabling the checker
 * everywhere it spreads. Every concrete `HermesTool<I, O>` is assignable to it —
 * `execute` because method parameters are bivariant, `input`/`output` because a
 * `Validator<I>` returns `I`, which is always an `unknown`.
 *
 * Written as `HermesTool` rather than `HermesTool<never, unknown>`, which was the
 * first attempt and is subtly wrong: `never` makes the *parameter* impossible to
 * satisfy under `exactOptionalPropertyTypes`, so a real tool would not fit the
 * list it was written for.
 */
export type AnyHermesTool = HermesTool;

/** What {@link defineTool} accepts. `execute` plus everything it can say. */
export interface ToolDefinition<TInput, TOutput> extends ToolMetadata {
  readonly name: string;
  readonly description: string;
  readonly input?: ToolSchema<TInput> | Validator<TInput>;
  readonly output?: ToolSchema<TOutput> | Validator<TOutput>;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
}

/**
 * Declare a tool.
 *
 * Does two things the kernel's `defineTool` does not, and each earns its place:
 *
 * 1. **Validates the declaration**, at module load. A tool with no name or no
 *    description is a wiring mistake, and it should fail where the wiring is
 *    rather than at the first call — the same argument the planner makes for
 *    rejecting an empty strategy chain at construction (RFC-0003 §5.2).
 * 2. **Attributes its own errors.** A `SchemaError` says `"path" must be a
 *    string`. It does not know which tool it belongs to — and, worse, it does not
 *    know which *side* it is on: the kernel validates a tool's output with the
 *    same `parse` contract as its input, so an output failure surfaces as
 *    `input must be a string`, which is exactly backwards. A model reading three
 *    failed observations cannot tell which tool complained, and a model told
 *    "input" about an output fault will rewrite its arguments forever.
 *
 * Note what it does **not** do: it does not enforce the output schema. The kernel
 * already does — `#invokeTool` ends `return tool.output ? tool.output.parse(output)
 * : output`. An earlier draft of this function wrapped `execute` to enforce it
 * too, on the belief that the kernel did not; `tests/tool.test.ts` proved
 * otherwise and the wrapper was double-parsing every result. Both validators are
 * therefore the kernel's own, wrapped only to say who they belong to.
 *
 * @throws {InvalidDefinitionError} when the declaration cannot work.
 */
export function defineTool<TInput, TOutput>(
  definition: ToolDefinition<TInput, TOutput>,
): HermesTool<TInput, TOutput> {
  const issues: string[] = [];
  if (definition.name.trim() === '') issues.push('a tool must have a non-empty name');
  if (definition.description.trim() === '') {
    // Enforced, not merely typed. The description is what a model reads to decide
    // whether to call this tool at all; one that cannot describe itself will
    // either never be chosen or be chosen at random.
    issues.push(
      'a tool must have a non-empty description — a model reads it to choose',
    );
  }
  if (definition.version !== undefined && !/^\d+\.\d+\.\d+/.test(definition.version)) {
    issues.push(`version "${definition.version}" is not semantic (expected "1.0.0")`);
  }
  if (issues.length > 0)
    throw new InvalidDefinitionError(definition.name || '(unnamed)', issues);

  const { input, output, ...rest } = definition;

  return defineKernelTool<TInput, TOutput>({
    ...rest,
    // Both wrapped, and the kernel calls both: `input` before `execute`, `output`
    // after (`runtime.ts` `#invokeTool`). Wrapping adds no validation — it adds
    // attribution, which is the half a `SchemaError` cannot supply on its own.
    ...(input === undefined
      ? {}
      : { input: attributed(definition.name, input, 'input') }),
    ...(output === undefined
      ? {}
      : { output: attributed(definition.name, output, 'output') }),
  });
}

/**
 * Wrap a validator so its failures say who they belong to, and which side.
 *
 * The returned object is still a `Validator`, and — critically — still a
 * `ToolSchema` when it was given one: `jsonSchema` is carried through, or
 * {@link describe} would find nothing to tell a model about a tool that
 * carefully declared a schema. That is this package's own bug reintroduced by its
 * own plumbing, so `tool.test.ts` pins it.
 *
 * The `side` is the reason this is not one wrapper. Input and output failures
 * mean opposite things to the model reading them: one is "you sent the wrong
 * thing", which it can fix by rewriting; the other is "the tool is broken", which
 * it cannot fix at all and must not try to.
 */
function attributed<T>(
  tool: string,
  validator: Validator<T> | ToolSchema<T>,
  side: 'input' | 'output',
): Validator<T> {
  const jsonSchema = (validator as ToolSchema<T>).jsonSchema as JsonSchema | undefined;

  return {
    ...(jsonSchema === undefined ? {} : { jsonSchema, optional: false }),
    parse: (raw: unknown): T => {
      try {
        return validator.parse(raw);
      } catch (thrown) {
        const message = toError(thrown).message;
        throw side === 'input'
          ? new InputInvalidError(tool, message, { cause: thrown })
          : // Without this the kernel reports an output fault as
            // `input must be a string` — the same `parse` contract on both sides,
            // and a `SchemaError` that has no idea which side it is on.
            new OutputInvalidError(tool, message, { cause: thrown });
      }
    },
  };
}

/**
 * Is this a tool that can describe its arguments?
 *
 * The runtime half of the gap in the module header: a `Tool` off the kernel's
 * registry is `HermesTool`-shaped only if whoever wrote it used this framework.
 * Everything that reads metadata goes through here rather than casting, so a
 * plain kernel tool degrades to "no schema, no tags" instead of `undefined`
 * reaching a prompt.
 */
export function isHermesTool(tool: Tool): tool is HermesTool {
  return typeof tool.name === 'string' && typeof tool.description === 'string';
}

/** The JSON Schema of a tool's input, if it declared one this framework can read. */
export function schemaOf(tool: Tool): JsonSchema | undefined {
  const input = tool.input as ToolSchema<unknown> | undefined;
  // A duck-type rather than an `instanceof`: `named()` above rebuilds the object,
  // a host may hand-roll a `ToolSchema`, and a Zod schema has no `jsonSchema` at
  // all. What matters is whether there is something to tell a model, not who made
  // it.
  return input !== undefined && typeof input.jsonSchema === 'object'
    ? input.jsonSchema
    : undefined;
}
