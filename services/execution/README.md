# @hermes/execution

Plans in, results out — and **data flowing between steps**.

The kernel runs a graph of tasks and refuses to know what they mean. The planner
decides what the graph is and refuses to run it. This runs it, and adds the one
thing neither could.

- **Design record:** [RFC-0004](../../docs/rfcs/RFC-0004-execution-engine.md) —
  why it is shaped this way, what it deliberately cannot do, and what was
  rejected.
- **Depends on:** `@hermes/kernel`, `@hermes/memory`, `@hermes/planner`. Public
  exports only.

## The gap it closes

RFC-0001 §11.4 is blunt about the kernel's limitation and about its fix:

> `dependsOn` is an ordering constraint, not a data flow... If this must change,
> the least-bad shape is probably an explicit, kernel-opaque reference —
> `input: { $from: 'a' }` resolved by the runtime at dispatch. **New RFC.**

This is that new RFC, with one change: resolution happens **above** the kernel,
so the kernel stays frozen and never learns that a payload means anything.
Everything it is good at — ordering, concurrency, retry, timeouts, cancellation,
the failure policy, the events `@hermes/memory` persists — is still the kernel
doing it. None of it is reimplemented here.

## Usage

The engine's envelope is a plugin, so it must be registered **before**
`runtime.start()` — the kernel takes plugins only in its `created` state.

```ts
import { ExecutionEngine } from '@hermes/execution';

const engine = new ExecutionEngine({ runtime, checkpoints, recovery });

runtime.use(engine.plugin());
await runtime.start();

const { plan } = await planner.plan({ statement: 'Summarise my day' });
const execution = await engine.execute(plan);
```

`execute` resolves for a plan that succeeded and **throws** for one that did not
— so a caller cannot forget to check.

## Threading outputs

A step reads an earlier step's output by naming it:

```ts
{
  name: 'brief',
  capability: { kind: 'agent', name: 'summariser' },
  dependsOn: ['fetch'],                            // required — see below
  input: {
    events: { $from: 'fetch' },                    // the whole result
    first:  { $from: 'fetch', path: 'items.0.title' },  // reach inside it
  },
}
```

References resolve anywhere inside the input: nested in objects, in arrays, at
any depth.

**A reference must name a declared dependency.** Without `dependsOn`, the kernel
may run the two concurrently and the reference would resolve against a result
that does not exist yet — a race that passes in tests and fails in production.
That disagreement is a compile-time error, not a coin toss.

**A missing path throws.** `a.b.c` quietly evaluating to `undefined` is the most
common way a data-flow bug reaches production wearing a disguise. The error
names the step that produced the value.

## Pause, resume, and crash recovery

Pause is **cancel-and-checkpoint**. The kernel has no pause, and this does not
add one (RFC-0004 §7.2) — the alternative, blocking at dispatch, deadlocks by
holding a concurrency slot.

```ts
await engine.pause(executionId); // cancels the mission; checkpoint is authoritative
await engine.resume(executionId); // new mission for the unfinished part
```

Steps that already succeeded are not re-run, and their results still resolve —
which is exactly why the execution context outlives any single mission.

The payoff: **pause and crash recovery are the same code path.** A dead process
leaves what a pause leaves — a checkpoint — so a new process picks it up with
`resume`. That is why a checkpoint carries the plan whole rather than by id.

```ts
for (const stale of await engine.checkpoints.pending()) {
  await engine.resume(stale.id); // on boot, after a crash
}
```

## Recovery

Off by default. Recovery re-runs steps, and whether that is safe depends on
whether your capabilities are idempotent — which this package cannot know.

```ts
new ExecutionEngine({
  runtime,
  recovery: {
    maxAttempts: 2,
    incomplete: 'retry', // required, no default — RFC-0003 §7.2
    shouldRecover: ({ failures }) =>
      failures.every((f) => f.code !== 'INVALID_INPUT'),
  },
});
```

This is **not** retry. The kernel already retries a task that threw — say
`maxAttempts: 3` on the step for that. Recovery is the layer above: the kernel
gave up, and the question is whether the _plan_ should be reshaped.

## Events

Published on the engine's own bus, never the kernel's.

```ts
engine.events.on('step:succeeded', ({ step }) =>
  console.log(step.name, step.result),
);
engine.events.on('mission:submitted', ({ executionId, missionId }) =>
  correlate(executionId, missionId),
);
```

`mission:submitted` is the only key between an execution and the kernel missions
`@hermes/memory` is already persisting.

## Public API

| Export                                                      | What it is                                               |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| `ExecutionEngine`                                           | `execute`, `pause`, `resume`, `snapshot`, `plugin`.      |
| `CheckpointStore`                                           | The port: what survives the process.                     |
| `InMemoryCheckpointStore`                                   | The default. Correct in-process; does not outlive it.    |
| `RecoveryPolicy`, `shouldRecover`, `NO_RECOVERY`            | When to replan, and when to stop.                        |
| `resolveRefs`, `validateRefs`, `isStepRef`, …               | The `$from` mechanism. Pure.                             |
| `ExecutionContext`                                          | What one execution knows so far. What `$from` reads.     |
| `compileExecution`                                          | Plan → `MissionSpec` of envelopes.                       |
| `stepEnvelope`, `STEP_AGENT_NAME`                           | The one agent. Registered via `engine.plugin()`.         |
| `ExecutionSnapshot`, `StepRecord`, `ExecutionCheckpoint`, … | Domain types. Plain, serialisable data.                  |
| `ExecutionError` + subclasses                               | Everything thrown on purpose, each with a stable `code`. |

`ExecutionError.code` is the contract; message wording is free to change
(RFC-0001 §5).

## Tests

```sh
pnpm test           # 197 tests, against a real kernel Runtime
pnpm test:coverage  # enforces a 95% threshold
```
