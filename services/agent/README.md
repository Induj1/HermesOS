# @hermes/agent

Reasoning and decision-making. **Decides what should happen; never makes it
happen.**

- **Design record:** [RFC-0005](../../docs/rfcs/RFC-0005-agent-framework.md) —
  why it is shaped this way, what it deliberately cannot do, what was rejected.
- **Depends on:** `@hermes/kernel`, `@hermes/memory`, `@hermes/planner`,
  `@hermes/model`. Public exports only. Nothing depends on it.

## The rule, and how it is enforced

An agent's only output is an `AgentDecision`:

```ts
type AgentDecision =
  | { kind: 'answer'; content: unknown }
  | { kind: 'tools'; requests: ToolRequest[] }
  | { kind: 'plan'; goal: Goal }
  | { kind: 'delegate'; agent: string }
  | { kind: 'abstain' };
```

**There is no variant that says "and I already did it."** A reviewer never has
to check whether a new reasoner secretly called a tool — the return type does
not let it say so.

The same trick runs through every port. A reasoner gets an `AgentContext` with
no registry (so it cannot invoke another agent), no `MemoryService` (so it
cannot write a memory — only `MemoryAdapter`, which reads), and no `Runtime` (so
it cannot start a mission). Nothing is prevented by convention.

## An agent is identity plus a reasoner

There is no `LlmAgent` or `RuleAgent` class. There is one `Agent`, and a field:

| you want              | you write                                |
| --------------------- | ---------------------------------------- |
| a deterministic agent | `reasoner: new RuleBasedReasoner(rules)` |
| an AI-powered agent   | `reasoner: new LlmReasoner({ model })`   |
| a composite agent     | `reasoner: new ReasonerChain([...])`     |
| a specialist agent    | narrow `tags`, and abstain readily       |

## Usage

```ts
import {
  AgentRuntime,
  defineAgent,
  LlmReasoner,
  memoryAdapter,
  NamedTools,
  ReasonerChain,
  RuleBasedReasoner,
} from '@hermes/agent';

const agents = new AgentRuntime({
  executor, // yours: wired to @hermes/execution or a kernel task
  memory: memoryAdapter(memory), // read-only; there is no write side
  agents: [
    defineAgent({
      name: 'assistant',
      description: 'Answers questions about the day ahead',
      // Order is policy: the model first, the rules behind it. When the model is
      // down, the rules answer. That is the whole fallback story — there is no
      // circuit breaker anywhere in this package.
      reasoner: new ReasonerChain([
        new LlmReasoner({ model, recall: 3 }),
        new RuleBasedReasoner(myRules),
      ]),
      tools: new NamedTools({ tags: ['calendar'] }),
    }),
  ],
});

const result = await agents.run('assistant', {
  input: 'what is on today?',
  subject: 'ada',
});
```

`run` resolves for every outcome, including abstention — an agent that abstained
_behaved correctly and said so_, and making a caller `catch` that would put a
normal outcome on the exception path and discard the transcript.

`LlmReasoner` is written against `@hermes/model`'s interfaces and **has no
provider**. It is finished, not deferred: the day an Ollama or Claude provider
ships, it is constructed with one and works.

## Tools: agents ask, something else acts

```ts
const decision = await agent.reasoner.reason(request, ctx);
// { kind: 'tools', requests: [{ id, name, kind, args }] }  ← a description
```

The session hands that batch to an `AgentExecutor` — an interface this package
declares and never implements. Implement it against `@hermes/execution`, or use
`kernelExecutor(ctx.tools)` inside a kernel task.

A failing tool is an `ok: false` **observation**, not a rejection: a tool
failing is something the agent should reason about, and a session that threw on
the first failure could never recover from one.

## Memory: agents read; writes are decisions

`MemoryAdapter` has `recall` and nothing else. An agent that wants to remember
something decides to — a `ToolsDecision` naming `memory.remember`, which
`@hermes/memory` already registers as a real tool. The write then goes out
through the same door as every other effect, where the scheduler sees it, the
audit log records it, and an approval middleware can refuse it.

## Middleware: the guard

```ts
const requireApproval: AgentMiddleware = async (request, ctx, next) => {
  const decision = await next(request, ctx);
  if (decision.kind !== 'tools') return decision;
  if (!decision.requests.some((r) => r.name.startsWith('payment.'))) return decision;
  return { kind: 'answer', content: 'That needs a human.' };
};

defineAgent({ ..., reasoner: withMiddleware(reasoner, [requireApproval]) });
```

`next` returns a decision — data describing what should happen, which has not
happened yet. In a framework where the agent had already run the tool, this
could only apologise.

## Exposing an agent to the kernel

```ts
runtime.use({
  name: 'agents',
  setup: (ctx) => {
    ctx.registerAgent(asKernelAgent(agents, 'assistant'));
  },
});
```

A whole session runs inside one kernel task. Tools really run — dispatched by
the kernel, counted against its concurrency — and the framework never touches
them. The cost: that session is invisible to the scheduler (RFC-0005 §7.4).

## Public API

| Export                                                       | What it is                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `AgentRuntime`                                               | Composition root. `register`, `run`, `session`, `capabilities`.    |
| `AgentSession`                                               | One request, run to a conclusion. The decide/execute/observe loop. |
| `defineAgent`, `capabilityOf`                                | Declare an agent; read what it says about itself.                  |
| `Reasoner`                                                   | The port AI plugs into. One method.                                |
| `RuleBasedReasoner`, `matches`                               | Deterministic. The floor the fallback story stands on.             |
| `LlmReasoner`, `renderTranscript`                            | Model-backed, against `@hermes/model`. No provider needed.         |
| `ReasonerChain`                                              | Try reasoners in order. Where degradation lives.                   |
| `AgentExecutor`                                              | The port work leaves through. Never implemented here.              |
| `MemoryAdapter`, `memoryAdapter`                             | Read-only memory. There is no write side.                          |
| `PlannerAdapter`                                             | For a reasoner that must plan _to decide_. Optional.               |
| `ToolSelectionStrategy`, `AllTools`, `NoTools`, `NamedTools` | Which capabilities an agent is told about.                         |
| `withMiddleware`                                             | Wrap a reasoner. Guards, logging, redaction.                       |
| `asKernelAgent`, `kernelExecutor`                            | Where the two meanings of "agent" meet.                            |
| `AgentDecision`, `AgentResult`, `SessionTurn`, …             | Domain types. Plain, serialisable data.                            |
| `AgentError` + subclasses                                    | Everything thrown on purpose, each with a stable `code`.           |

## Tests

```sh
pnpm test           # 172 tests
pnpm test:coverage  # enforces a 95% threshold
```
