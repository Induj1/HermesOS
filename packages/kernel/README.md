# @hermes/kernel

The Hermes core runtime — it knows how to run a graph of tasks toward a goal,
and nothing else. Zero dependencies, no network, no database, no AI. Every
concrete capability arrives as a `Plugin` registering `Tool`s and `Agent`s;
everything observable leaves through the `EventBus`.

- **Design record:** [RFC-0001](../../docs/rfcs/RFC-0001-hermes-kernel.md).
- **Depends on:** nothing.

## Usage

```ts
import { Runtime } from '@hermes/kernel';

const runtime = Runtime.create({ concurrency: 8 });
runtime.use(calendarPlugin).use(plannerPlugin);
await runtime.start();

const result = await runtime.run({
  name: 'morning-brief',
  goal: 'Summarise the day ahead',
  tasks: [/* … */],
});
```

## What it provides

- **`Runtime`** — registers plugins, runs missions, bounded concurrency,
  lifecycle (`start`/`stop`).
- **`Mission` / `Task` / `Scheduler`** — a goal decomposed into a task graph,
  scheduled with retry/backoff.
- **`Plugin` / `PluginContext` / `definePlugin`** — the one extension seam
  (register tools/agents, observe the bus, hook disposal).
- **`Tool` / `Agent`** contracts (`defineTool`, `defineAgent`).
- **`EventBus`** and the typed `KernelEventMap` — everything observable.
- **`Clock` / `systemClock` / `TestClock`** — injected time, so the whole system
  is deterministic under test.
- **`Logger` / `noopLogger`**, id generation (`randomIds`, branded `MissionId`/
  `TaskId`), `topoSort`, and a `StateMachine` primitive.

Persistence, models, and I/O deliberately live outside the kernel — see
`@hermes/memory` (RFC-0002) and the provider/tool packages.
