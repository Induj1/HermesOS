/**
 * @hermes/tools — authoring tools that can describe themselves.
 *
 * ## The gap it closes
 *
 * The kernel's `Tool` is name, description, two optional `Validator`s and
 * `execute`, and `ToolAccess.list()` returns only `{ name, description }`. That is
 * right for the kernel, which dispatches by name and refuses to know what a
 * payload means (RFC-0001 §2).
 *
 * One layer up it leaves a hole. `@hermes/agent`'s `AvailableCapability` declares
 * `parameters` and `tags`, and `LlmReasoner` hands `parameters` straight to a
 * model — so today **a model is told a tool exists and never what arguments it
 * takes.** It guesses. And `NamedTools({ tags: [...] })` selects on tags a kernel
 * tool cannot carry, so it matches nothing.
 *
 * `tests/kernel-gap.test.ts` pins both, as properties of the frozen packages
 * below. If either ever closes it, this layer should shrink.
 *
 * ## How it closes it
 *
 * A {@link HermesTool} **is** a kernel `Tool` — assignable, registrable — with
 * extra fields the kernel never reads. That is the seam the kernel named for
 * agents ("free-form capability tags... carried for routing layers built above
 * it; it never reads them itself" — kernel `agent.ts`), used for tools, from the
 * outside, with no kernel change.
 *
 * ## One declaration, two consumers
 *
 * A {@link ToolSchema} is a `Validator` **and** carries `jsonSchema`. So the thing
 * that enforces the arguments and the thing that describes them to a model are
 * the same object, and they cannot drift:
 *
 * ```ts
 * import { defineTool, s, PermissionSet, toolset } from '@hermes/tools';
 *
 * const readFile = defineTool({
 *   name: 'fs.read',
 *   description: 'Read a UTF-8 text file from disk.',
 *   tags: ['filesystem', 'read'],
 *   permissions: ['fs:read'],
 *   idempotent: true,
 *   input: s.object({
 *     path: s.string({ description: 'Absolute path to the file.' }),
 *     maxBytes: s.withDefault(s.number({ integer: true, minimum: 1 }), 1_000_000),
 *   }),
 *   output: s.string(),
 *   examples: [{ description: 'Read a config', input: { path: '/etc/hosts' } }],
 *   execute: async ({ path, maxBytes }, ctx) => read(path, maxBytes, ctx.signal),
 * });
 *
 * runtime.use(toolset({
 *   name: 'filesystem',
 *   tools: [readFile],
 *   granted: PermissionSet.none().grant('fs:read'),
 * }));
 * ```
 *
 * `execute` is typed from the schema — `path` is a `string`, `maxBytes` a
 * `number` — with no generic to write and no cast.
 *
 * See `docs/rfcs/RFC-0006-tool-framework.md` for why it is shaped this way.
 */

export { defineTool, isHermesTool, schemaOf } from './tool.js';
export type {
  AnyHermesTool,
  HermesTool,
  ToolDefinition,
  ToolExample,
  ToolMetadata,
} from './tool.js';

export * as s from './schema.js';
export type { Infer, JsonSchema, ToolSchema, Shape, InferShape } from './schema.js';

export { catalog, describe, toModelDefinition } from './catalog.js';
export type { CatalogOptions, DescribeOptions, ToolDescription } from './catalog.js';

export { assertPermitted, PermissionSet } from './permissions.js';
export type { Permission } from './permissions.js';

export { withMiddleware, withPermissions, withPermissionsAll } from './middleware.js';
export type { NextCall, ToolMiddleware } from './middleware.js';

export { toolset } from './toolset.js';
export type { ToolSetOptions } from './toolset.js';

export { auditTool, callTool, spyTool, testContext } from './testing.js';
export type { TestContextOptions } from './testing.js';

export {
  InputInvalidError,
  InvalidDefinitionError,
  OutputInvalidError,
  PermissionDeniedError,
  SchemaError,
  ToolError,
  ToolNotFoundError,
  toError,
} from './errors.js';
export type { ToolErrorCode } from './errors.js';
