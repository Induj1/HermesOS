# @hermes/model

What an AI provider promises. Contracts, and nothing else.

**Zero dependencies** — not even on the kernel.

- **Design record:** [RFC-0005](../../docs/rfcs/RFC-0005-agent-framework.md) §4
  — why this is its own package.

## Why it is separate

```
            ┌──────────────────┐
            │  @hermes/model   │   (contracts; no dependencies)
            └────────┬─────────┘
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   providers     model router   @hermes/agent
   (ollama,      (picks one)    (calls one)
    claude, …)
```

An Ollama provider is an HTTP client and nothing more. If these interfaces lived
in `@hermes/agent`, it would have to import a _reasoning framework_ to declare
its own shape, and the model router — which picks between providers — would have
to import the thing that will call it. Both are the dependency graph pointing
outward.

The payoff is already collected: **`@hermes/agent`'s `LlmReasoner` is finished
and tested, and no provider exists.** The reasoning layer was completable ahead
of the provider layer, because the contract is separable from both.

## The one rule

**Nothing here can execute anything.** A model is _told_ a capability exists
(`ToolDefinition`) and _requests_ one (`ToolCall`). There is no field, method or
type in this package that runs a tool.

That is what makes "agents never execute tools directly" structural rather than
a rule someone has to remember.

## Implementing a provider

```ts
import {
  type ToolCallingModel,
  ModelUnavailableError,
  RateLimitedError,
} from '@hermes/model';

export class OllamaModel implements ToolCallingModel {
  readonly info = {
    name: 'llama3',
    provider: 'ollama',
    contextWindow: 8192,
    // Declared, not inferred. A router that matched on model *names* would be a
    // table of string prefixes that is wrong the day a provider ships a new one.
    supports: { chat: true, tools: true, streaming: true },
  };

  async chat(messages, options) {
    // Honour `options.signal`. A model call is the slowest thing in the system,
    // and one that ignores its signal holds a kernel concurrency slot long after
    // the caller has gone (RFC-0001 §11.1).
  }

  async chatWithTools(messages, tools, options) {
    /* … */
  }
}
```

Throw the errors from this package rather than your own. `ModelError.retryable`
is the single field a router branches on, and if every provider threw its own
shapes that question would be answered by matching on message text — the thing
that breaks silently when a vendor rewords a string.

| error                       | retryable | because                                       |
| --------------------------- | --------- | --------------------------------------------- |
| `ModelUnavailableError`     | yes       | someone else has a comparable model up        |
| `ModelTimeoutError`         | yes       | the request was fine                          |
| `RateLimitedError`          | yes       | the request was fine                          |
| `InvalidRequestError`       | no        | just as invalid at the next provider          |
| `ContentFilteredError`      | no        | a refusal, not a fault                        |
| `ContextTooLongError`       | **no**    | see below                                     |
| `AuthenticationFailedError` | no        | do not hammer this provider with the same key |

`ContextTooLongError` looks like a capacity problem, so a router is tempted to
reach for a bigger window. But the same oversized prompt fails at three
providers and bills for two: the fix is to send less, and only a caller can
decide that.

## Public API

| Export                                                           | What it is                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ChatModel`                                                      | Holds a conversation. What `LlmReasoner` is written against.       |
| `ToolCallingModel`                                               | Can be told about tools and will ask for them.                     |
| `StreamingModel`                                                 | Answers incrementally, as an `AsyncIterable`.                      |
| `CompletionModel`                                                | Continues text. Genuinely different from chat.                     |
| `EmbeddingModel`                                                 | Text to vector. A strict superset of memory's `EmbeddingProvider`. |
| `ModelMessage`, `ToolCall`, `ToolDefinition`, `ModelResponse`, … | The vocabulary.                                                    |
| `system`, `user`, `assistant`, `toolResult`                      | Message constructors.                                              |
| `wantsTools`, `isTruncated`, `totalUsage`                        | The three checks every consumer needs.                             |
| `ModelError` + subclasses, `isRetryable`                         | Failure classification.                                            |

`EmbeddingModel` is a superset of `@hermes/memory`'s `EmbeddingProvider`, so one
object satisfies both and a host wires the same embedder into memory and into a
router with no adapter. That claim is pinned by compile-time assertions in
`services/agent/tests/memory-adapter.test.ts` — the only place both interfaces
are visible, since this package cannot see memory at all.

## Tests

```sh
pnpm test           # 42 tests
pnpm test:coverage  # enforces a 95% threshold
```

The contracts themselves are type-only and excluded from coverage: they emit no
runtime code. What they promise is enforced by the providers that implement them
and the consumers that call them.
