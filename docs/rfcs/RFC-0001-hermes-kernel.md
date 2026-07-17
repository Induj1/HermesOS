# RFC-0001: The Hermes Kernel

| Field         | Value                                |
| ------------- | ------------------------------------ |
| Status        | Implemented                          |
| Date          | 2026-07-17                           |
| Scope         | `packages/kernel` (`@hermes/kernel`) |
| Supersedes    | —                                    |
| Superseded by | —                                    |

This RFC is the design record for the Hermes kernel. It exists because the code
can tell you _what_ the kernel does but not _why_ it refuses to do anything
else, and the "why" is the part that decays first. Where a decision has a
plausible alternative that was considered and rejected, the rejected option is
recorded here with the reason. If you are about to change something in
`packages/kernel` and this document explains why it is the way it is, that is
not a prohibition — it is the argument you now have to beat.

Read this alongside the source. Every claim below is implemented and covered by
tests in `packages/kernel/tests`.

---

## 1. Context

HermesOS is a personal operating system for agents. The kernel is the layer
everything else is built on: apps (`apps/telegram`, `apps/api`), services
(`services/planner`, `services/memory`), and whatever a future contributor adds.

A layer in that position gets exactly one chance to be minimal. Every dependency
it takes, every concept it learns, every assumption it bakes in becomes load
bearing for the whole system and effectively permanent — you can refactor a leaf
service on a Tuesday, but you cannot refactor the thing that eight packages
import without stopping the world.

So the kernel was built by asking, for every candidate feature, "can this live
outside?" If yes, it lives outside.

## 2. The organising principle

> **The kernel decides _when_ things run. It never knows _what_ they do.**

Nearly every decision in this document is a corollary. When a future change
feels ambiguous, apply this test first: does the proposal require the kernel to
understand the _meaning_ of the work? If so, it belongs in a plugin or a service
above the kernel.

Concretely, the kernel knows how to take a goal expressed as a graph of tasks,
work out which tasks are runnable, run them within a concurrency budget, retry
them, time them out, cancel them, and announce everything that happened. It does
not know what a calendar is, what a message is, or what a model is.

## 3. Non-goals

These are not "not yet" — they are structural. The kernel must never learn:

- **AI, models, prompts, embeddings.** Not deferred; excluded. The kernel's job
  is scheduling, and a scheduler that knows what an LLM is has a dependency on a
  vendor's uptime and pricing. See §5.3 for the seam AI plugs into.
- **Transports.** No Telegram, HTTP, WebSocket, or CLI. These are hosts that
  drive the kernel, not features of it.
- **Persistence.** No database, no file system, no cache. See §11.2 for the seam
  a store plugs into.
- **Business logic.** No notion of a "morning brief", a "reminder", or a
  "contact". Those are missions authored above the kernel.
- **Configuration and secrets.** Injected, never read. The kernel does not touch
  `process.env`.

**Enforcement.** `packages/kernel/package.json` has an empty `dependencies`
object, and `src/` contains no import from outside itself — not even
`node:crypto`. If you are adding an import that is not `./something.js`, stop
and re-read this section. The zero-dependency property is verifiable in one
command:

```sh
grep -rhoE "from '[^.][^']*'" packages/kernel/src   # must print nothing
```

Keep it that way. It is the cheapest possible test for "did the kernel start
learning things it should not know".

## 4. Module map

Seventeen modules in `packages/kernel/src`, one concept each.

| Layer     | Module         | Responsibility                                     |
| --------- | -------------- | -------------------------------------------------- |
| Contracts | `tool.ts`      | A named capability: input in, output out           |
|           | `agent.ts`     | A named handler with authority to choose tools     |
|           | `plugin.ts`    | The only way anything enters the kernel            |
| Domain    | `mission.ts`   | A goal as a DAG of tasks; all graph rules          |
|           | `task.ts`      | One unit of work and its state machine             |
| Machinery | `runtime.ts`   | Composition root; handler resolution; lifecycle    |
|           | `scheduler.ts` | When and how many; retries, timeouts, cancellation |
|           | `event-bus.ts` | The kernel's only outbound coupling                |
|           | `lifecycle.ts` | The shared state machine                           |
|           | `registry.ts`  | Name → thing, with a no-clobber rule               |
| Support   | `clock.ts`     | Time as an injected capability                     |
|           | `logger.ts`    | The logging shape the kernel expects               |
|           | `ids.ts`       | Branded ids and injectable generation              |
|           | `errors.ts`    | Every error the kernel throws on purpose           |
|           | `graph.ts`     | Topological sort, shared by missions and plugins   |
|           | `events.ts`    | The event catalogue — the observable surface       |
| Entry     | `index.ts`     | The public API                                     |

The dependency direction is strict and worth preserving: **Support ← Domain ←
Machinery ← Entry**. `mission.ts` and `task.ts` import from support modules and
each other, but never from `scheduler.ts`, `runtime.ts`, or `events.ts`. That is
what keeps the domain testable with no machinery present (§12).

---

## 5. The abstractions

Each subsection states what the abstraction is, why it exists at all, what was
rejected, and the invariants that must survive future edits.

### 5.1 Tool

```ts
interface Tool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly input?: Validator<TInput>;
  readonly output?: Validator<TOutput>;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
}
```

**Why it exists.** It is the smallest unit the kernel can execute. "Send an
email", "query the calendar", "read a file". A tool has no memory and no
authority: it does not decide when it runs or what runs next.

**Why tools are looked up by name, never imported.** This is the decision that
makes a mission plain data. A task says
`{ kind: 'tool', name: 'calendar.today' }`, which is serialisable, inspectable,
loggable, and could arrive over a wire. A function reference is none of those.
Every downstream capability we care about — persisting a mission, replaying it,
showing it in a UI, letting a planner _compose_ one — depends on the mission
being data rather than closures. The registry indirection is the price.

**`Validator<T>` and why there is no Zod dependency.**

```ts
interface Validator<T> {
  parse(input: unknown): T;
}
```

This is structurally compatible with a Zod schema, so a plugin can pass
`z.object({...})` straight in and it type-checks. But the kernel does not depend
on Zod, or any validation library.

- _Rejected: depend on Zod._ It is a good library, but it would be the kernel's
  only runtime dependency, and validation-library choice churns on a ~3-year
  cycle (io-ts → Zod → Valibot → ArkType → …). Baking one in dates the kernel to
  its era and forces every plugin author onto it. The one-method interface costs
  nothing and outlives the fashion.
- _Rejected: JSON Schema._ Requires a validator implementation to be useful,
  which is the same dependency wearing a hat.
- _Rejected: no validation at all._ Then `unknown` input reaches `execute` and
  every tool author writes their own type assertion, badly. See §5.10 for why
  `parse` is load bearing rather than decorative.

**Invariant.** `execute` must honour `ctx.signal`. The kernel's cancellation is
cooperative and it cannot force-kill you (§11.1).

### 5.2 Agent

```ts
interface Agent<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly capabilities?: readonly string[];
  readonly input?: Validator<TInput>;
  handle(input: TInput, ctx: AgentContext): Promise<TOutput>;
}
```

**Why it exists separately from Tool.** Structurally they are nearly the same
shape, which invites the question "why two?". The difference is **authority**,
not structure. A tool executes a fixed effect. An agent receives the tool
registry via `ctx.tools` and _chooses_ what to call.

That distinction earns its keep in exactly one place, and it is the important
one: it is where the kernel stops. The kernel deliberately says nothing about
_how_ an agent chooses. A hand-written `if`/`else`, a rules table, a state
machine, and a model-backed planner all satisfy this interface identically.

- _Rejected: collapse Agent into Tool._ Then either every tool gets the registry
  (and any tool can call any tool, so the no-authority property of tools
  evaporates), or nothing does (and there is no seam for planning). The
  distinction is cheap and the property is worth keeping.
- _Rejected: give the kernel an `AgentKind` enum with a `'model'` variant._ This
  is the AI dependency arriving through the back door.

**`capabilities` is carried, never read.** The kernel does not interpret the
tags. They exist for a routing layer above the kernel that will want to ask
"which agent can do X" without the kernel growing an opinion about what X means.

### 5.3 The AI seam (for the reader who arrives here to add AI)

This is the section you are looking for. AI enters HermesOS as **a plugin that
registers an agent**. Nothing in the kernel changes. Specifically:

```ts
const plannerPlugin = definePlugin({
  name: 'planner',
  setup: (ctx) => {
    ctx.registerAgent({
      name: 'planner',
      description: '...',
      handle: async (input, ctx) => {
        // Call a model here. ctx.tools.list() is your tool manifest;
        // ctx.tools.invoke(name, input) executes one. ctx.signal is your
        // deadline. Return the result.
      },
    });
  },
});
```

`ToolAccess.list()` returns `{ name, description }` pairs — deliberately the
exact shape a model tool-manifest wants. That was not an accident, but it is
also not a commitment: if the manifest needs schemas too, extend `ToolAccess`,
not the kernel's understanding of models.

**The thing to be careful about.** A model-backed planner will want to
_generate_ tasks. Today it cannot: a mission's DAG is fixed at `Mission.create`
(§11.3). That is the sharpest known limitation and the most likely reason
someone will want to change the kernel. Read §11.3 before you do.

### 5.4 Plugin

```ts
interface Plugin {
  readonly name: string;
  readonly version?: string;
  readonly dependsOn?: readonly string[];
  setup(ctx: PluginContext): void | Promise<void>;
}
```

**Why it exists.** The kernel ships with no tools and no agents. Plugins are the
only way anything gets in. That is what keeps the kernel's dependency list from
growing as the _system_ grows: a Telegram transport, a Postgres store, and a
model-backed planner are all just plugins to a runtime that has never heard of
any of them.

**Why `setup` receives a `PluginContext` and not the `Runtime`.** A plugin
should be able to register capabilities and observe events. It should not be
able to start missions, reach into the scheduler, or stop the runtime that owns
it. Handing over the `Runtime` would grant all of that by default and there
would be no way to walk it back once plugins existed in the wild. The narrow
context is the whole point.

**Why `dependsOn` and topological setup ordering.** A plugin whose agent needs
another plugin's tools registered before it can inspect them has a genuine
ordering requirement. Encoding it as data (`dependsOn: ['calendar']`) and
sorting means registration order at the call site does not matter — which
removes a class of "works on my machine, breaks in the other host" bug where two
hosts call `use()` in different orders. Cycles are rejected at `start()` with
the cycle path in the message.

**Failure handling, and why it is asymmetric.**

- _Setup failure_ aborts `start()` entirely, and the runtime unwinds every
  plugin that already came up. A half-initialised runtime is worse than one that
  never started: it looks alive, serves missions with a partial tool registry,
  and fails in ways that point at the wrong plugin. Note in `#setupPlugin` that
  the failing plugin is pushed to the registered list _before_ the throw — that
  is deliberate, so anything it managed to register before dying still gets its
  disposers run.
- _Dispose failure_ does **not** stop the other disposers. One plugin leaking a
  handle must not cause every subsequent plugin to leak one too. The error is
  reported as a `kernel:error` event and teardown continues.

Disposal runs in reverse setup order, so a plugin releases its resources before
anything it depended on releases theirs.

### 5.5 Mission and Task

**Mission** is the kernel's unit of intent: a goal, expressed as a DAG of tasks.
**Task** is one unit of work. Together they own the graph and every rule that
follows from it.

**Why they are pure.** `Mission.refresh(now)` takes a timestamp and returns the
tasks whose state changed. It emits nothing, awaits nothing, and touches no
clock. The scheduler decides what to announce and what to run.

This is the most valuable structural decision in the package. Mission logic —
which tasks are runnable, which must be skipped, when the whole thing is done —
is the fiddliest code in the kernel, and it is testable with no scheduler, no
clock, no bus, and no async at all. `tests/mission.test.ts` drives the entire
graph algebra synchronously. If you make `refresh` emit an event or await
something, you will have traded that away for nothing.

**`goal` is carried, never interpreted.** It is a human-readable statement of
intent for logs and UIs. The kernel does not parse it. (A planner above the
kernel might.)

**Task states.**

```
pending    dependencies not yet satisfied
ready      runnable; waiting for a scheduler slot
running    in flight
succeeded  produced a result                      (terminal)
failed     threw, with no attempts left           (terminal)
cancelled  abandoned by mission/runtime shutdown  (terminal)
skipped    an upstream task did not succeed       (terminal)
```

**Why `failed` is terminal, and retry uses a `running → ready` edge instead.**
The tempting model is `running → failed → ready` for a retry. It was rejected:
it makes `failed` a state you cannot trust, so every reader — the settlement
check, the UI, the future store — has to cross-reference the attempt counter to
know whether a "failed" task is actually finished. With the retry edge going
`running → ready` directly, `failed` means _exhausted_, full stop, and
`isTerminal` needs no context. `TASK_TRANSITIONS` in `task.ts` is the source of
truth.

**Why `skipped` is distinct from `cancelled`.** They answer different questions.
`skipped` means "your dependency died, so you were never going to run"; the
error message names the dependency. `cancelled` means "someone stopped this".
Collapsing them loses the causal chain exactly when you most want it — when
you're reading a failed mission's tasks trying to find the first domino. §9.1
records a bug where this distinction was nearly lost to an ordering mistake.

**Why `notBefore` lives on the Task.** A retrying task is `ready` but not yet
runnable. Rather than a separate "waiting" state (which would need its own edges
and its own terminality question), the task carries an earliest-dispatch
timestamp and `readyTasks(now)` filters on it. See §8.3 for why this matters to
concurrency.

**`startedAt` is stamped once** (`??=`), on the first attempt — it answers "when
did this task begin", not "when did the latest retry begin". `attempts`
increments per run. Both are load bearing for anyone reasoning about latency.

**Snapshots.** `task.snapshot()` and `mission.snapshot()` return plain data.
Events carry snapshots, never live objects (§5.7).

**Validation collects every issue.** `Mission.create` throws
`MissionValidationError` with an `issues: string[]`, not on the first problem
found. Someone fixing a hand-authored spec wants all six mistakes at once, not
six edit-run cycles. Validated: non-empty name, non-empty task list, unique task
names, no self-dependency, no dangling dependency, no cycles,
`maxAttempts >= 1`, `timeoutMs > 0`.

**Failure policy.**

| Policy      | Behaviour                                                        | Use when                                          |
| ----------- | ---------------------------------------------------------------- | ------------------------------------------------- |
| `fail-fast` | Abandon everything still outstanding (default)                   | Tasks share a goal; a partial result is worthless |
| `continue`  | Only the failed task's dependents skip; independent branches run | Fan-out work where each branch stands alone       |

`fail-fast` is the default because the common case is a mission whose tasks
serve one goal, and burning budget on work whose output is about to be discarded
is strictly worse than stopping.

**Settlement precedence — a failure outranks a cancellation.** If any task
`failed`, the mission is `failed`, even when a fail-fast sweep cancelled the
rest. The alternative (report `cancelled` because that is what happened last) is
technically true and practically useless: the cause of death is more informative
than the mechanism that finished it off. Only if nothing failed and something
was cancelled is the mission `cancelled`.

**`requestCancel` does not touch running tasks.** It marks `pending`/`ready`
tasks cancelled and records intent. Running tasks are aborted through their
signal by whoever owns the controller, and report their own cancellation when
they unwind. Two writers to one task's state is a race; one writer is not.

### 5.6 Scheduler

**Why it exists as its own object.** It is the only place in the kernel with
concurrency logic. Missions decide what is _runnable_; the scheduler decides
what actually _runs_ — the concurrency cap, retry backoff, per-task timeouts,
cancellation.

**Why it is handed a `TaskExecutor` instead of the registries.**

```ts
type TaskExecutor = (task: Task, signal: AbortSignal) => Promise<unknown>;
```

The scheduler knows nothing about tools or agents. It gets a function and calls
it. Two payoffs: "how do I run a task" (the runtime's problem) stays out of "in
what order and how many" (the scheduler's problem); and the scheduler tests with
a two-line fake, which is why `tests/scheduler.test.ts` can cover the retry and
timeout matrix without ever registering a tool.

**Why `submit` resolves and never rejects.** It settles with the final
`MissionSnapshot` whatever happens — success, failure, cancellation. A mission
that fails is a normal outcome to inspect, not an exception to catch: a snapshot
with three of five tasks succeeded is _information_, and rejecting would throw
it away in favour of a single error. Callers who want throw-on-failure can check
`snapshot.state` in one line; callers who want the detail cannot recover it from
a rejection.

**Task selection is global across missions.** `#nextTask` picks the
highest-priority runnable task across _all_ active missions, not per-mission
round-robin. A low-priority task in an old mission should not beat a
high-priority one just because its mission was submitted first. Ties break on
`createdAt`, then (within a mission, via `readyTasks`) on name — deterministic,
which matters for testability. Selection is O(active tasks) per dispatch; at
kernel scale this is irrelevant, and if it ever is not, that is a real signal
worth measuring rather than a thing to pre-optimise.

**Defaults.** Concurrency 4. `defaultRetryDelay` is exponential,
`min(30_000, 100 * 2 ** (attempt - 1))`. Task defaults: `maxAttempts: 1` (no
retry), `priority: 0`, no timeout. The no-retry default is deliberate: retries
are only safe for idempotent work, and the kernel cannot know whether your tool
is. Opt in per task.

See §8 for the concurrency invariants, which are the subtle part.

### 5.7 EventBus

**Why it exists.** It is the kernel's only outbound coupling. Nothing inside
calls out to a logger, a database, or a transport; it announces what happened
and whoever cares subscribes. This is what lets persistence, metrics, and
transports be added later without the kernel learning they exist.

**Decision: `emit` awaits its listeners.** A slow subscriber therefore slows the
emitter. This surprises people, so: it is the point. A subscriber writing task
results to disk must be able to apply **backpressure** rather than fall silently
behind the scheduler and lose events on shutdown. Fire-and-forget would make the
scheduler faster and the system lossy.

- _Rejected: `void`-return emit (fire-and-forget)._ Lossy under shutdown, and
  makes ordering untestable.
- _Rejected: run listeners in parallel via `Promise.all`._ Non-deterministic
  ordering for no real gain; listeners are expected to be cheap or to buffer
  internally.

If a subscriber genuinely needs to be slow, it should buffer internally and
return immediately — that is a decision for the subscriber, and it is now an
explicit one rather than a silent default.

**Decision: a throwing listener never breaks the emit.** Errors route to
`onListenerError` and the remaining listeners still run. One bad observer must
not be able to wedge the scheduler. The `Runtime` wires this to a `kernel:error`
event plus a log line.

**Snapshot semantics.** `emit` snapshots the listener array before delivering. A
listener that subscribes or unsubscribes mid-delivery does not affect the
delivery already in flight; it joins from the next emit. Without this, mutating
during iteration is a silent skipped-listener bug.

**`onAny`** exists for observability — logging, tracing, a debug console — where
enumerating event names would mean editing the observer every time the kernel
grows an event.

**`waitFor`** always tears down its subscription, including on abort. A
`waitFor` that never fires must not leak a listener.

**Type-level decision: `EventMap = object`, not `Record<string, unknown>`.**
This looks like a loosening and is actually a usability fix. Only a `type` alias
gets an implicit index signature; an `interface` does not. With the `Record`
constraint, every consumer declaring their event map as an `interface` — the
natural choice, and the one `@typescript-eslint`'s `consistent-type-definitions`
autofix will _impose on them_ — failed with
`Index signature for type 'string' is missing`, an error that does not explain
itself. The constraint bought nothing: every key is read through
`keyof M & string` regardless. This was discovered the hard way when ESLint's
autofixer rewrote `KernelEventMap` from a type alias into an interface and broke
the build (§9.3). Do not re-tighten it.

### 5.8 Events (`events.ts`)

The event catalogue is the kernel's observable surface, deliberately in one file
so it can be read as a whole.

**Every payload carries snapshots, never live objects.** A subscriber cannot
mutate a task by holding an event, and an event stays true to the moment it
described even if the task moves on. This is what makes the stream safe to
persist, replay, or ship over a wire — see §11.2.

Events: `runtime:{starting,started,stopping,stopped}`,
`plugin:{registered,disposed}`,
`mission:{submitted,started,succeeded,failed,cancelled}`,
`task:{ready,started,succeeded,failed,retrying,cancelled,skipped}`,
`scheduler:idle`, `kernel:error`.

`scheduler:idle` announces the _edge_ into idle, not every settle that happens
while idle (`#idleAnnounced`). An event that fires repeatedly for an unchanged
condition trains people to ignore it.

`kernel:error` is for things that threw where nothing should have — a listener,
a dispose. Reported rather than propagated, because the alternative is a
subscriber's bug taking down the scheduler.

### 5.9 Lifecycle (`StateMachine`)

Task, Mission, and Runtime all have a lifecycle. Rather than scatter
`if (this.state === 'running')` guards across three files, each declares a
transition table and shares one machine.

**The value is that illegal moves fail loudly, at the moment they are attempted,
with the subject named.**
`task "send-email" cannot transition from "succeeded" to "running"` is a bug
report. A silently ignored double-completion is a debugging session that starts
three days later with corrupt state.

`tryTo` exists for the genuinely idempotent callers (`mission.start()`), so
"already there" does not have to be an exception.

- _Rejected: a state-machine library._ This is 60 lines and the kernel takes no
  dependencies.
- _Rejected: `enum` for states._ Banned by `erasableSyntaxOnly` (§10), and
  string unions are better anyway — they serialise as themselves.

### 5.10 Runtime

**Why it exists.** It is the composition root, and it owns the one thing nothing
else could: turning a task's `{ kind, name }` handler reference into an actual
call. The scheduler decides _when_; the runtime knows _what_.

**Lifecycle:** `created → starting → running → stopping → stopped`.

- **`stopped` is terminal.** A stopped runtime is rebuilt, not revived. Restart
  would mean re-running plugin setup against registries that already have
  entries, and the no-clobber rule (§5.11) would reject it — so "restart" would
  be a lie or a special case. Neither is worth it; construct a new Runtime.
- **`created → stopped` is legal**, so stopping a runtime that never started is
  a no-op rather than an error. Shutdown paths should not have to know how far
  `start()` got.
- **Plugins must be registered before `start()`.** Registration after start
  would mean a mission could observe the tool registry changing underneath it.

**Stop modes.** `drain` (default) lets in-flight missions finish; `cancel`
aborts them now. Both then dispose plugins. Default is `drain` because the
common shutdown is a deploy, and finishing a 200ms task beats abandoning it.

**Handler resolution, and where `unknown` becomes typed.** `#invokeTool` is the
single place a task's input — which arrived as `unknown`, possibly off a wire —
becomes the tool's own type:

```ts
const input = tool.input ? tool.input.parse(rawInput) : rawInput;
const output = await tool.execute(input, ctx);
return tool.output ? tool.output.parse(output) : output;
```

`parse` is what earns the type. A tool that declares a validator gets its input
checked _here_, before `execute`, rather than trusted downstream. Output is
validated symmetrically — a tool that lies about its return type fails its own
task rather than corrupting a dependent.

**`AnyTool` — and why not `never`, and why not `any`.** A registry is
heterogeneous; it needs a type that every concrete `Tool<I, O>` is assignable
to. (In the source this reads `export type AnyTool = Tool`, because the
parameters default to `unknown` — it is `Tool<unknown, unknown>` spelled short.
Same for `AnyAgent`.)

- _Rejected: `Tool<any, any>`._ `any` disables the checker everywhere it
  spreads, and it spreads.
- _Rejected (and initially shipped, then found broken): `Tool<never, unknown>`._
  The reasoning was that method parameters are bivariant, so `execute` would
  accept it, and `never` would force the one call site to acknowledge a cast
  rather than let unsoundness leak. **This is wrong**, and the compiler only
  says so once a consumer tries it: the optional `input?: Validator<TInput>`
  makes the type invariant in `TInput`, because `Validator<never>` requires
  `parse` to _return_ `never`. No concrete tool is assignable to
  `Tool<never, unknown>`. See §9.2.
- _Chosen: `Tool<unknown, unknown>`._ `execute` is assignable via
  method-parameter bivariance; `input`/`output` are assignable because a
  `Validator<I>` returns `I`, which is always an `unknown` (covariant). It also
  removed both `as never` casts — the honest version needed _fewer_ casts than
  the clever one.

The bivariance is the unsound part and it is deliberate: a heterogeneous
registry cannot be typed otherwise. `Validator` is what makes it safe at
runtime.

**`ToolAccess.invoke` returns `Promise<unknown>`.** A generic
`invoke<O>(name): Promise<O>` was rejected: it would assert a type nobody
checked. The caller knows what it asked for and narrows deliberately.

**Agents share the task's context.** The `ToolAccess` handed to an agent carries
the same signal, logger, and deadline as the task itself, so a tool invoked by
an agent is cancelled by the same abort that cancels the agent.

### 5.11 Registry

Name → thing, with one rule: **registering a duplicate name throws.**

Two plugins that both define a `search` tool is a conflict the host must resolve
explicitly. Last-write-wins would make it a race decided by plugin load order —
the worst kind of bug, because it is invisible, environment-dependent, and
silently changes which code runs.

`require` throws `NotFoundError`; `get` returns `undefined`. Both exist because
"missing" is a bug at some call sites and a normal branch at others.

The `Runtime` exposes `tools`/`agents` as `ReadonlyRegistry`. Capabilities enter
through plugins, not through a back door on the runtime object.

### 5.12 Graph (`topoSort`)

Shared by `Mission` (task ordering) and `Runtime` (plugin setup ordering) — both
are "these things depend on those things, reject cycles".

**Returns a result, does not throw.** The two callers report failure very
differently: a mission collects issues into a `MissionValidationError`, the
runtime throws a `RuntimeStateError` immediately. A result type lets each
decide.

**DFS, not Kahn's algorithm.** Kahn's is the usual choice and detects cycles
fine — but it tells you _that_ a cycle exists, not which one. A failure here is
always a human's authoring mistake, so DFS's colour marking earns its keep by
handing back the actual path (`a -> b -> c -> a`).

Failure modes are distinguished (`duplicate`, `missing`, `cycle`) because they
have different fixes.

---

## 6. Cross-cutting decisions

### 6.1 Time is injected

The kernel never calls `Date.now()` or `setTimeout`. Every timestamp and delay
goes through `Clock`.

**Why.** Retry backoff and task timeouts are the two hardest things in the
kernel to test, and with real time they are tested by really sleeping — which
makes the suite slow, flaky, and so unpleasant that the edge cases quietly go
untested. With `TestClock`, `advance(1_000)` is instant and deterministic. The
entire retry and timeout matrix in `tests/scheduler.test.ts` runs in
milliseconds.

`TestClock.pendingTimers` is a leak detector: a test asserting it reaches 0 is
asserting the kernel cleaned up after itself.

**Invariant.** If you add a timer to the kernel and reach for `setTimeout`, you
have just made a class of behaviour untestable. Use the clock.

_Trap for the unwary (found while writing the tests):_ advancing a `TestClock`
past a timer that has not been registered yet strands it forever. Wait for the
observable that proves the timer exists — e.g. the `task:retrying` event — then
advance.

### 6.2 The Logger interface is re-declared, not imported

`@hermes/logger` exists in this workspace. The kernel does not use it.

The kernel has zero dependencies (§3), and this interface is small enough that
any structured logger satisfies it _structurally_ — including `@hermes/logger`,
with no adapter. The host injects a real one; `noopLogger` is the default, so
the kernel is silent unless asked.

- _Rejected: depend on `@hermes/logger`._ One workspace dependency is all it
  takes for "the kernel depends on nothing" to stop being checkable, and the
  next one is always easier to justify than the first.

### 6.3 Ids are branded and injectable

`MissionId` and `TaskId` are branded strings. The brand is erased at runtime —
they are ordinary strings — but it stops a `TaskId` from being passed where a
`MissionId` belongs, which is otherwise invisible until something looks up the
wrong map at 3am.

`IdGenerator` is injected so tests can make ids deterministic (`sequentialIds()`
yields `mission_1`, `task_1`, …). Production uses `randomIds` (prefixed UUIDv4,
via the global `crypto` — note: _global_, so that even `node:crypto` is not
imported, per §3).

**Nothing in the kernel derives meaning from an id's shape.** The prefix is a
debugging affordance, not a protocol. Do not parse ids.

_Trap (hit while writing the scheduler tests):_ a fresh `sequentialIds()` per
mission hands out `mission_1` twice, and the scheduler's `#entries` map then
treats two missions as one. Share one generator per host/test-harness.

### 6.4 Errors carry codes

Every kernel error extends `KernelError` with a stable `KernelErrorCode`.
Callers — and the services that will sit above the kernel — branch on `code`,
never on the message, so message wording stays free to change.

`toError(unknown)` exists because JavaScript lets you throw a string. Every
catch block in the kernel funnels through it rather than assuming
`catch (e: Error)`.

One oddity worth not "fixing": `safeStringify` uses
`JSON.stringify(value) ?? String(value)`, and
`@typescript-eslint/no-unnecessary-condition` flags the `??` as dead code. The
rule is wrong: `JSON.stringify` is _declared_ as returning `string` but
genuinely returns `undefined` for `undefined`, a function, or a symbol — all of
which can be thrown. There is a scoped disable with this explanation at the call
site.

---

## 7. Public API

`index.ts` is the contract. The intended shape of a host:

```ts
const runtime = Runtime.create({ concurrency: 8 });
runtime.use(calendarPlugin).use(plannerPlugin);
await runtime.start();

const result = await runtime.run({
  name: 'morning-brief',
  goal: 'Summarise the day ahead',
  tasks: [
    { name: 'fetch', handler: { kind: 'tool', name: 'calendar.today' } },
    {
      name: 'brief',
      handler: { kind: 'agent', name: 'summariser' },
      dependsOn: ['fetch'],
    },
  ],
});

await runtime.stop();
```

`run` submits and awaits the snapshot. `submit` returns the `Mission` without
waiting, for callers who want to follow it on the bus and hold its id. `idle()`
waits for everything.

---

## 8. Concurrency invariants

This is the subtle part of the package. Each of these is load bearing; each has
a test; and each is easy to break with a well-meaning refactor.

### 8.1 A task is claimed synchronously, before any `await`

In `Scheduler.#pump`:

```ts
task.markRunning(this.#clock.now());
this.#inFlight.add(task.id);
this.#idleAnnounced = false;
void this.#dispatch(task, entry);
```

`markRunning` and `inFlight.add` happen before control can yield. If a claim
moved after an `await`, the `while` loop could pick the same task twice and run
it concurrently with itself. **Never introduce an `await` between selection and
claim.**

### 8.2 `refresh` runs to a fixed point

Skipping cascades: marking `b` skipped is what makes `c`, which depends on `b`,
skippable. A single pass would leave `c` pending until some unrelated event
triggered another refresh — and if none ever did, the mission would hang instead
of settling. `refresh` loops until nothing changes. See §9.1.

Because `refresh` is fully synchronous, it is also atomic with respect to the
event loop: two tasks settling concurrently cannot interleave inside it. That is
why the "who promotes the task" question has no race in it. Keep it synchronous.

### 8.3 A retry does not hold a concurrency slot

On a retryable failure the task goes back to `ready` with
`notBefore = now + delay`, the slot is released, and a **detached** timer
re-pumps when the backoff comes due. `#waitingRetries` tracks these so
`drain`/`isIdle` do not declare victory early.

The obvious implementation — `await clock.sleep(delay)` inside `#dispatch` —
would hold the slot for the whole backoff. With a 30s cap and concurrency 4, a
handful of flaky tasks would stall the entire runtime while doing nothing.

### 8.4 Timeouts race a clock sleep, and the loser never settles

```ts
const expiry = this.#clock.sleep(timeoutMs, timerController.signal).then(
  () => { taskController.abort(...); throw new TaskTimeoutError(...); },
  () => new Promise<never>(() => undefined),
);
try {
  return await Promise.race([this.#executor(task, signal), expiry]);
} finally {
  timerController.abort();
}
```

The rejection handler returning a **forever-pending promise** is not a mistake.
When the work finishes first, the `finally` aborts the timer, which rejects the
sleep. The race is already decided, so nobody is listening — and a rejection
nobody is listening for is an `unhandledRejection` that crashes the process
under Node's default policy. Never settling is correct: the branch is
irrelevant, and the promise is garbage collected with the race.

A timeout is a normal failure and is therefore retryable.

### 8.5 Cancellation ordering: mark, then abort

`#cancelEntry` marks queued tasks cancelled _before_ aborting the controller, so
in-flight tasks unwind into the same `#afterProgress` pass. And in
`#handleFailure`, cancellation is checked **first** — a task killed by shutdown
neither failed nor deserves a retry.

### 8.6 Fail-fast cascades skips before it sweeps

See §9.1. `refresh` runs before `#cancelEntry` so dependents settle as `skipped`
(naming their dead dependency) rather than as `cancelled` casualties of the
sweep.

---

## 9. Bugs found during implementation

Recorded because each one is a trap that a future change could re-introduce, and
because two of them prove the tests are earning their keep.

### 9.1 Fail-fast reported `cancelled` where `skipped` was true

**Symptom.** With the default `fail-fast` policy, a dependent of a failed task
settled as `cancelled` rather than `skipped`.

**Cause.** `#handleFailure` called `#cancelEntry` immediately after marking the
task failed. `requestCancel` swept every `pending`/`ready` task — including the
dependents that the skip cascade was about to claim — so the sweep won the race
and the causal information ("your dependency `a` failed") was replaced with
"cancelled".

**Fix.** `refresh` (cascade the skips) before the sweep. Also exposed that
`refresh` only cascaded one level per call, which was fixed by running it to a
fixed point (§8.2) — that one was latent and could have hung a deep chain.

### 9.2 `AnyTool = Tool<never, unknown>` was unusable

**Symptom.** Every consumer got
`TS2379: Type '{ value: string; }' is not assignable to type 'never'` — but only
from the _tests_, because `src/` alone never instantiated the type.

**Cause.** Reasoning from method bivariance while forgetting that
`input?: Validator<TInput>` makes the type invariant. Detailed in §5.10.

**Lesson worth keeping.** The kernel compiling proves nothing about whether its
generic types are _usable_. This is precisely why `tsconfig.json` type-checks
`tests/` as well as `src/` (§10) — the tests are the kernel's only consumer
until the services arrive, and therefore its only proof that the public types
work.

### 9.3 The linter's autofix broke the build

`@typescript-eslint`'s `consistent-type-definitions` rewrote `KernelEventMap`
from a type alias to an `interface`, which no longer satisfied a
`Record<string, unknown>` constraint. Rather than fight the linter with a
disable, the constraint was relaxed to `object` (§5.7) — the rule was right that
an interface is idiomatic, and the constraint was wrong to forbid it.

---

## 10. Toolchain constraints

Inherited from `tsconfig.base.json` and `eslint.config.js`. These shape the code
and are not negotiable from inside the kernel.

- **`erasableSyntaxOnly`** — no `enum`, no `namespace`, no parameter properties.
  Hence string-union states and hand-written constructors. This keeps the door
  open to `node --experimental-strip-types` and to swapping `tsc` for a faster
  transpiler.
- **`nodenext`** — relative imports need the `.js` extension, even from `.ts`.
- **`verbatimModuleSyntax`** — type-only imports must say `import type`.
- **`exactOptionalPropertyTypes`** — this is why snapshot fields are declared
  `readonly startedAt: number | undefined` rather than `startedAt?: number`.
  Building a snapshot conditionally to satisfy `?` would be noise; the explicit
  `| undefined` says "always present, sometimes empty", which is what a snapshot
  is. It is also why `Runtime` spreads options conditionally into
  `SchedulerOptions`.
- **`noUncheckedIndexedAccess`** — `arr[0]` is `T | undefined`.
- **`strictTypeChecked`** — `any` is effectively banned; see §5.10.

**Package build layout.** The kernel is the only package with a split tsconfig:

- `tsconfig.json` — the editor/lint/typecheck view. Includes `src`, `tests`, and
  `vitest.config.ts`; `noEmit`.
- `tsconfig.build.json` — build only. `rootDir: src`, `outDir: dist`, tests
  excluded.

The split exists because `dist/` must mirror `src/` for the package's `exports`
paths to be honest (`./dist/index.js`), while ESLint's `projectService` and the
type-checker both need `tests/` covered by _a_ tsconfig. A single config with
`rootDir: "."` would emit `dist/src/index.js` and break `exports`. §9.2 is why
type-checking the tests is not optional.

**Vitest** is in the workspace catalog (`pnpm-workspace.yaml`) so versions
cannot drift. `allowBuilds: { esbuild: true }` is required: pnpm blocks
dependency install scripts by default, and esbuild's is what links its platform
binary — without it `pnpm test` cannot start. It is the only unblocked build.

---

## 11. Known limitations and extension points

Ordered by how likely you are to hit them.

### 11.1 Cancellation is cooperative

The kernel aborts via `AbortSignal`. It **cannot force-kill** an executor that
ignores it. A tool that never checks `ctx.signal` and never returns will hold a
concurrency slot forever, and `stop({ mode: 'cancel' })` will not save you.

This is a property of the platform, not a shortcut: there are no threads to kill
here. The mitigations available are the ones already present — per-task
`timeoutMs`, and documenting the obligation on `Tool.execute` (§5.1). If this
becomes a real operational problem, the honest fix is process isolation (run
untrusted tools in a worker), which is a _plugin-level_ decision — the kernel
would still just be awaiting a promise.

Pinned by a test in `tests/scheduler.test.ts`, which uses a signal-honouring
executor precisely because a non-cooperative one hangs.

### 11.2 No persistence — but the seam is the event stream

The kernel is in-memory and single-process. A restart loses every in-flight
mission.

The seam is deliberate and already load bearing: **every event carries a
snapshot** (§5.8), and snapshots are plain, serialisable data. A store is a
plugin that subscribes — most likely via `onAny` — and writes. Because `emit`
awaits (§5.7), such a plugin gets real backpressure rather than silently
lagging.

What is _not_ yet solved, and would need design: rehydrating a mission
mid-flight after a crash. `Mission` has no constructor from a snapshot, and a
task that was `running` when the process died has genuinely unknown status (did
the effect happen?). That is an at-least-once/idempotency conversation, not a
kernel feature. Start it in a new RFC.

### 11.3 A mission's DAG is fixed at creation

`Mission.create` validates and freezes the task list. Nothing can add a task to
a running mission.

This is the sharpest limitation, and the one most likely to bite the AI work
(§5.3): a planner that discovers mid-flight that it needs three more steps
cannot express that. Today's workaround is that an _agent_ can do unbounded work
inside its single task by calling tools in a loop — which is enough for a lot,
but the sub-steps are invisible to the scheduler (no per-step retry, no
concurrency accounting, no events).

If you need dynamic tasks, the options roughly are:

1. **A mission per plan step**, composed by a service above the kernel.
   Cheapest; no kernel change; loses cross-step concurrency accounting.
2. **Sub-missions** — a task that submits another mission and awaits it. Needs
   care with the concurrency budget (a parent blocking on a child while holding
   a slot is a deadlock at concurrency 1) and with cancellation propagation.
3. **Mutable missions** — `mission.addTask()` with revalidation of the DAG. The
   fixed-point `refresh` (§8.2) already tolerates the graph changing between
   calls, so this is less invasive than it looks. But it breaks the "a mission
   is a value you can reason about" property, and every consumer of a
   `MissionSnapshot` would have to cope with the task list growing.

The recommendation, absent a compelling reason, is (1) or (2). Do not reach for
(3) casually.

### 11.4 Tasks do not receive their dependencies' outputs

`dependsOn` is an ordering constraint, not a data flow. A task's `input` is
static, fixed in the spec. `b` depending on `a` does **not** receive `a`'s
result.

This surprises people, and it is the second most likely reason to want a kernel
change. It is not an oversight: any data-flow mechanism (a template language, a
selector syntax, a mapping function) is the kernel learning about the _meaning_
of task payloads, which §2 forbids.

Today's workarounds: an agent calls the tools it needs in sequence and threads
the values itself; or the host reads `snapshot.tasks[].result` and composes the
next mission.

If this must change, the least-bad shape is probably an explicit, kernel-opaque
reference — `input: { $from: 'a' }` resolved by the runtime at dispatch —
because it stays plain data and keeps the mission serialisable. It would still
need a real design for partial/multiple dependencies. New RFC.

### 11.5 No mission-level timeout

Tasks have `timeoutMs`; missions do not. A mission of many slow-but-legal tasks
can run indefinitely. A host can implement this today with `cancelMission` on a
timer, which is why it is not in the kernel.

### 11.6 No priority ageing

Priority is static. A steady stream of high-priority tasks can starve a
low-priority one indefinitely. Acceptable at personal-assistant scale;
`#nextTask` is where ageing would go if it stops being acceptable.

### 11.7 `submit` is unbounded

There is no admission control or queue limit; the scheduler will accept
unlimited missions and hold them in memory. Backpressure at the submit boundary
is the host's business today.

### 11.8 Single-process

No distribution, no work stealing, no multi-node coordination. Out of scope, and
should stay out — a distributed scheduler is a different artefact with different
failure modes, and would be a new package rather than a change to this one.

---

## 12. Testing strategy

161 tests, one file per module, `tests/`. `pnpm --filter @hermes/kernel test`.

The strategy follows the architecture:

- **Domain tests are synchronous.** `mission.test.ts` and `task.test.ts` drive
  the entire graph algebra and state machine with no scheduler, no clock, no
  bus, no async. This is the payoff for keeping `Mission.refresh` pure (§5.5).
  It is also where the subtle rules (skip cascade, settlement precedence,
  `notBefore` gating) are cheapest to pin down.
- **Scheduler tests use a fake executor and a `TestClock`.** The whole retry,
  timeout, cancellation, and concurrency matrix runs in ~600ms with zero real
  waiting. Cancellation tests use signal-honouring executors deliberately
  (§11.1).
- **Runtime tests are the integration layer** — real plugins, real tools, real
  agents, exercising resolution, validation, and lifecycle.
- **Type-level coverage is not incidental.** §9.2 is the reason `tests/` is
  type-checked: the tests are the kernel's only consumer until the services
  exist, and therefore the only proof that its public generics are usable.

**Determinism.** `TestClock` for time, `sequentialIds()` for ids, deterministic
tie-breaking in task selection. There are no `sleep(50)`-and-hope tests, and
there should never be one: `vi.waitFor` on an observable, or an event, or both.

---

## 13. Invariants — the short list

If you change the kernel, these are the things that quietly break. Each is
justified above; this is the checklist.

1. **Zero dependencies.** No imports outside `src/`. Verify with the grep in §3.
2. **No `Date.now()`, no `setTimeout`.** Time goes through `Clock` (§6.1).
3. **`Mission.refresh` stays pure and synchronous.** No emits, no awaits (§5.5,
   §8.2).
4. **No `await` between task selection and claim** in `#pump` (§8.1).
5. **Retries never hold a concurrency slot** (§8.3).
6. **The timeout loser never settles** — do not "fix" the forever-pending
   promise (§8.4).
7. **Events carry snapshots, never live objects** (§5.8).
8. **`emit` awaits listeners; listener errors never propagate** (§5.7).
9. **Duplicate registration throws** (§5.11).
10. **`failed` is terminal; retry goes `running → ready`** (§5.5).
11. **A failure outranks a cancellation at settlement** (§5.5).
12. **Handlers are referenced by name; missions stay plain data** (§5.1).
13. **Tests are type-checked, not just run** (§9.2).

---

## 14. Open questions

Deliberately unresolved. Each is a future RFC, not a TODO.

1. **Dynamic tasks** (§11.3) — sub-missions vs mutable missions vs
   mission-per-step. Will be forced by the planner work.
2. **Data flow between tasks** (§11.4) — is `{ $from: 'a' }` worth the
   complexity, or is agent-threads-it-itself sufficient in practice?
3. **Crash recovery** (§11.2) — rehydration needs an idempotency story before it
   needs code.
4. **Per-tool concurrency limits** — one rate-limited API can currently consume
   every slot. A `Tool.maxConcurrency` is tempting and cheap; it is not in
   because nothing has needed it yet, and an unused knob is a liability.
5. **Structured task results** — `result: unknown` is honest but pushes
   narrowing onto every consumer. A discriminated result type might pay for
   itself once there are real consumers.

---

## Appendix: changing this document

If you make a decision that contradicts something here, update this file in the
same change that lands the code, and say what changed your mind. A design record
that lags the code is worse than none, because it is trusted and wrong.
