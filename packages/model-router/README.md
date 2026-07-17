# @hermes/model-router

Capability-based routing and fallback across model providers, presented as one
`ChatModel`.

- **Design record:** [RFC-0014](../../docs/rfcs/RFC-0014-model-router.md).
- **Depends on:** `@hermes/model` (contracts), `@hermes/kernel` (Logger).

## The idea

A deployment has several models; the reasoner wants one. The router selects a
provider by **declared capability** (`ModelInfo.supports`) and falls back to the
next on a **retryable failure** (`ModelError.retryable`), stopping on a
definitive one. Adding a provider is registering it — no caller changes.

## Usage

```ts
import { ModelRegistry, RoutingChatModel } from '@hermes/model-router';

const registry = new ModelRegistry()
  .register(localLlama) // prefer the cheap local model…
  .register(claude); // …fall back to the API when it is unavailable

const model = new RoutingChatModel(registry);

await model.chat(messages); // routed, with fallback
await model.chatWithTools(messages, tools); // only tool-capable models considered
await model.chat(messages, { extra: { route: { models: ['claude'] } } }); // pin one call
```

Registration order is the default preference order. `RoutingChatModel`
implements `ChatModel`/`ToolCallingModel`, so it drops straight into the agent's
reasoner.

## Behaviour

- **Select** by `features` (capability), `provider`, or an explicit `models`
  order — `selectCandidates` is a pure function you can test directly.
- **Fall back** past a retryable `ModelError` (rate limit, unavailable,
  timeout).
- **Stop** on a non-retryable one (invalid request, content filter, auth) — it
  is the answer everywhere.
- **`NoCandidatesError`** when nothing matches; **`AllFailedError`** (with every
  attempt) when the chain is exhausted.

## Testing

`FakeChatModel` is a deterministic, scriptable model:

```ts
import { FakeChatModel, response } from '@hermes/model-router';
import { RateLimitedError } from '@hermes/model';

const flaky = new FakeChatModel({
  name: 'flaky',
  provider: 'openai',
  script: [new RateLimitedError('openai'), response({ content: 'ok' })],
});
```

It records every call, so a test can assert which models the router tried, in
order, and that it stopped when it should have.
