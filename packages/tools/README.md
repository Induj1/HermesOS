# @hermes/tools

Authoring tools that can **describe themselves** — so a model is told what a
tool takes, not just that it exists.

- **Design record:** [RFC-0006](../../docs/rfcs/RFC-0006-tool-framework.md) —
  why it is shaped this way, what it deliberately cannot do, what was rejected.
- **Depends on:** `@hermes/kernel` and `@hermes/model`. Public exports only.

## The gap it closes

The kernel's `Tool` has no parameter schema and no tags, and `ToolAccess.list()`
returns only `{ name, description }`. So against a plain kernel tool, today:

- **a model is told a tool exists and never what arguments it takes** — it
  guesses `{ file }` for a tool that wants `{ path }`, and every call fails on a
  validator it was never shown;
- **`NamedTools({ tags: [...] })` matches nothing**, because a kernel tool has
  no tags to select on.

`tests/kernel-gap.test.ts` pins both as properties of the frozen packages below.
This framework closes them from the outside, with no kernel change: a
`HermesTool` **is** a kernel `Tool` with extra fields the kernel never reads.

## One declaration, two consumers

A tool's arguments are described twice in every agent system — as JSON Schema
for the model, as a runtime check for the tool — and when they are separate they
drift. A `ToolSchema` is **both**, so they cannot:

```ts
import { defineTool, s, PermissionSet, toolset } from '@hermes/tools';

const readFile = defineTool({
  name: 'fs.read',
  description: 'Read a UTF-8 text file from disk.',
  tags: ['filesystem', 'read'],
  permissions: ['fs:read'],
  idempotent: true,
  input: s.object({
    path: s.string({ description: 'Absolute path to the file.' }),
    maxBytes: s.withDefault(s.number({ integer: true, minimum: 1 }), 1_000_000),
  }),
  output: s.string(),
  examples: [{ description: 'Read a config', input: { path: '/etc/hosts' } }],
  execute: async ({ path, maxBytes }, ctx) => read(path, maxBytes, ctx.signal),
});
```

`execute`'s `{ path, maxBytes }` is typed from the schema — no generic, no cast
— and the JSON Schema the model sees is generated from the same declaration.

## Schemas

| Factory                       | Parses to        |
| ----------------------------- | ---------------- |
| `s.string(opts)`              | `string`         |
| `s.number(opts)`              | `number`         |
| `s.boolean()`                 | `boolean`        |
| `s.enumOf(['a', 'b'])`        | `'a' \| 'b'`     |
| `s.array(inner, opts)`        | `T[]`            |
| `s.object(shape, opts)`       | inferred shape   |
| `s.optional(inner)`           | `T \| undefined` |
| `s.withDefault(inner, value)` | `T`              |
| `s.unknown()`                 | `unknown`        |
| `s.nothing()`                 | `{}`             |

Errors name the field a model must fix: `"files.1.path" must be a string`, not
`invalid input`. Deliberately small — no unions, no refinements — because a
tool's arguments come from a model, and the vocabulary here is the one a model
reliably gets right (RFC-0006 §7.1). A host that wants Zod still can:
`Tool.input` is `Validator`, which a Zod schema satisfies structurally.

## Discovery

```ts
import { catalog, toModelDefinition } from '@hermes/tools';

// What a model is told — straight into chatWithTools.
const definitions = catalog(runtime.tools).map((t) => t);
const forModel = toModelDefinition(readFile);
```

`describe()` returns a shape assignable to `@hermes/agent`'s
`AvailableCapability` with no adapter — so wiring a runtime's tools to a
reasoner is one line, and this package never imports the agent framework. A
plain kernel tool degrades to name and description; a schema is never
fabricated.

## Permissions

Declaration plus grant — **not** authorisation (that is a later subsystem; this
has no concept of a user).

```ts
import { PermissionSet, withPermissions } from '@hermes/tools';

const granted = PermissionSet.none().grant('fs:read'); // fs:* grants a whole domain
const guarded = withPermissions(writeFile, granted); // refuses fs:write at call time
```

## Toolsets

A group wired in one act — a plugin, not a new abstraction:

```ts
runtime.use(
  toolset({
    name: 'filesystem',
    tags: ['filesystem'], // added to every tool, for NamedTools to select on
    granted: PermissionSet.none().grant('fs:read'),
    tools: [readFile, listDir, writeFile], // writeFile registers and refuses
  }),
);
```

## Testing utilities

Shipped, because the people who need them are plugin authors outside this repo:

```ts
import { callTool, testContext, auditTool } from '@hermes/tools';

// Calls a tool exactly as the kernel does — parse input, execute, parse output.
expect(await callTool(readFile, { path: '/etc/hosts' })).toBe('contents');

// Catches the legal-but-always-wrong: an example that violates the schema, a
// description too short to choose by.
expect(auditTool(readFile)).toEqual([]);
```

## Public API

| Export                                                    | What it is                                                |
| --------------------------------------------------------- | --------------------------------------------------------- |
| `defineTool`                                              | Declare a tool. Validates at load; attributes errors.     |
| `s.*`                                                     | The schema DSL. A `Validator` that also describes itself. |
| `HermesTool`, `ToolMetadata`, `Infer`                     | The types.                                                |
| `catalog`, `describe`, `toModelDefinition`                | Read metadata back, render it for a model.                |
| `PermissionSet`, `assertPermitted`                        | Declaration plus grant. Not authorisation.                |
| `withMiddleware`, `withPermissions`, `withPermissionsAll` | Wrap a tool. Keeps its name and schema.                   |
| `toolset`                                                 | A group of tools as a kernel plugin.                      |
| `callTool`, `testContext`, `auditTool`, `spyTool`         | Testing utilities. Shipped.                               |
| `ToolError` + subclasses                                  | Everything thrown on purpose, each with a stable `code`.  |

## Tests

```sh
pnpm test           # 175 tests
pnpm test:coverage  # enforces a 95% threshold
```
