# RFC-0017: Context Builder

| Field         | Value                                  |
| ------------- | -------------------------------------- |
| Status        | Implemented                            |
| Date          | 2026-07-18                             |
| Scope         | `packages/context` (`@hermes/context`) |
| Depends on    | `@hermes/model` (ModelMessage)         |
| Supersedes    | —                                      |
| Superseded by | —                                      |

Design record for the context builder: assembling an agent turn's candidate
context into a model prompt that fits the token budget, deterministically.

Covered by 23 tests in `packages/context/tests`.

---

## 1. Context

An agent turn has more candidate context than fits a model's window: a system
instruction, the conversation so far, memories retrieved for this turn, and the
tool definitions the model will be given. Something must decide what makes the
cut. That is this package.

The governing constraint is **determinism**. An agent whose prompt depends on
timing or a coin flip is one whose behaviour cannot be reproduced and whose
regressions cannot be bisected. So the builder does no model call and uses no
randomness: the same inputs always produce the same prompt.

## 2. The priority

Highest first:

1. **System instruction** — always included; it defines the agent. If it alone
   overflows the budget it is _still_ included and the reported `tokens` exceed
   the budget — a signal, not a silent truncation of the one thing that must
   never be dropped.
2. **Tool definitions** — their token cost is _reserved_ (the caller passes
   `toolTokens`), because the model is given the tools regardless; the builder
   only accounts for the space they take.
3. **Recent history** — included newest-first until the budget runs out, then
   emitted in chronological order. Recent turns matter most.
4. **Retrieved memory** — included by descending relevance score until the
   remaining budget runs out, emitted as one block after the system message.

## 3. Why dropping, not summarising

The obvious alternative to dropping overflow is summarising it. But
summarisation needs a model call — slow, costly, and non-deterministic, the
three properties a context assembler must not have. Dropping by priority is free
and reproducible, and a caller who wants summarisation does it _before_ handing
history in. The builder owns the mechanical, reproducible half.

## 4. Token estimation

Packing a budget needs token counts, but the builder must not depend on a
tokenizer: the real one is model-specific (a `tiktoken`, a SentencePiece), would
tie this pure package to a vendor and a WASM blob, and its decisions are robust
to a small error anyway (it reserves headroom). So the default is the well-known
~4-characters-per-token heuristic plus a small per-message overhead (role
markers and delimiters cost a few tokens each), and a caller with a real
tokenizer passes one as `TokenEstimator`. The heuristic runs slightly _high_,
the safe direction.

## 5. Decoupling

The builder takes generic `MemorySnippet`s (`{ id, text, score }`), so it
depends on `@hermes/model` for `ModelMessage` and nothing else. A caller feeds
it results from `@hermes/memory` without this package ever importing a database
— the dependency points the right way, and the builder is testable with plain
objects.

## 6. Output and accounting

`build` returns the `messages` (system → memory block → history) plus a full
account: `tokens` (the true cost of what was emitted, including reserved tool
tokens), `includedMemories`/`droppedMemories` (by id), and `droppedHistory` (a
count). The account is what lets a caller log or react to what did not fit,
instead of discovering it as a truncated model call.

## 7. Testing

Deterministic, with computed (not magic) token counts: assembly order, inclusion
and omission of each section, history trimming (keep-newest, drop-all,
tool-token accounting), memory selection (rank by score, drop lowest under
pressure), the always-include-system overflow case, the default reserve, and the
`rankMemories` ordering (descending score, missing scores last, stable). Branch
coverage 97.3%.

## 8. Non-goals

- **No summarisation** (§3) — deliberately the caller's, done before `build`.
- **No retrieval** — the builder ranks and packs memories it is _given_;
  deciding _which_ memories to retrieve is `@hermes/memory`'s and the agent's
  job.
- **No real tokenizer** — a heuristic by default; inject one for exactness.
