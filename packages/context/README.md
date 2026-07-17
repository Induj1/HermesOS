# @hermes/context

Budget-aware, deterministic context assembly — system instruction, conversation
history, and retrieved memory into a model prompt that fits.

- **Design record:** [RFC-0017](../../docs/rfcs/RFC-0017-context-builder.md).
- **Depends on:** `@hermes/model` (for `ModelMessage`) — and nothing else.

## The idea

An agent turn has more candidate context than fits. The builder decides what
makes the cut under a token budget, by a **fixed priority** and with **no model
call and no randomness** — so the same inputs always produce the same prompt.

Priority, highest first: **system** (always) → **tools** (cost reserved) →
**recent history** (newest-first) → **relevant memory** (by score).

## Usage

```ts
import { ContextBuilder } from '@hermes/context';

const builder = new ContextBuilder({
  maxTokens: 128000,
  reserveForResponse: 2048,
});

const { messages, tokens, includedMemories, droppedHistory } = builder.build({
  system: agentInstruction,
  history: conversationSoFar, // ModelMessage[], chronological
  memories: retrieved, // { id, text, score }[] from @hermes/memory
  toolTokens: toolBudget, // tokens the tool defs will cost the model
});

const answer = await model.chat(messages);
```

`messages` is `system → memory block → history`. The result also accounts for
what did not fit — `droppedHistory`, `droppedMemories` — so a caller can log or
react rather than discover truncation at the model.

## Notes

- **Deterministic** — no summarisation (do that before `build`), no retrieval
  (the builder ranks memories it is _given_).
- **Token estimation** defaults to the ~chars/4 heuristic plus per-message
  overhead; pass a `TokenEstimator` (a real `tiktoken`) for exactness.
- **Decoupled** — takes generic `MemorySnippet`s, so it never imports a
  database.
- **System is never dropped** — if it alone overflows, it is still included and
  the reported `tokens` exceed the budget as an honest signal.
