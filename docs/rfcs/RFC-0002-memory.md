# RFC-0002: The Memory Service

| Field         | Value                                |
| ------------- | ------------------------------------ |
| Status        | Implemented                          |
| Date          | 2026-07-17                           |
| Scope         | `services/memory` (`@hermes/memory`) |
| Depends on    | RFC-0001 (the Hermes kernel)         |
| Supersedes    | —                                    |
| Superseded by | —                                    |

This RFC is the design record for the memory service. Like RFC-0001, it exists
because the code can tell you _what_ the service does but not _why_ it refuses
to do anything else. Where a decision has a plausible alternative that was
considered and rejected, the rejected option is recorded with the reason. If you
are about to change something in `services/memory` and this document explains
why it is the way it is, that is not a prohibition — it is the argument you now
have to beat.

Read this alongside the source. Every claim below is implemented and covered by
tests in `services/memory/tests` (279 of them).

---

## 1. Context

The kernel is finished and frozen. It knows how to run a graph of tasks toward a
goal and refuses to learn anything else — in particular it refuses
**persistence** ("No database, no file system, no cache") and it refuses **AI**
("models, prompts, embeddings. Not deferred; excluded"). See RFC-0001 §3.

Both of those refusals create the same hole, and this service fills it. An
assistant that forgets everything on restart is a chatbot; one that remembers is
an assistant. That is the whole product difference, and it lives here.

The memory service answers three questions, and the split between them is the
most important structural decision in this document (§4):

| Question               | Mechanism           | Verbatim? | Prunable? |
| ---------------------- | ------------------- | --------- | --------- |
| What was said?         | conversation memory | yes       | no        |
| What is worth keeping? | memory records      | no        | yes       |
| What happened?         | mission persistence | yes       | yes       |

## 2. The organising principle

> **The kernel decides when things run. Memory decides what survives.**

The kernel's test — "does this require the kernel to understand the _meaning_ of
the work?" — has a counterpart here: **does this require judgement about what
matters?** If yes, it belongs in this service, behind an interface, with a
replaceable default. If it is a mechanical fact (a row exists; a vector is 768
wide), it can be concrete.

Everything in §7 and §8 follows from that. Every judgement this service makes —
what a memory is worth, what to forget, what to retrieve — is an interface with
a default implementation that is _explicitly_ a placeholder, because every one
of those judgements is eventually a model's job and none of them is today.

## 3. Dependency rules

**The dependency runs one way and it is enforceable.**

- This service imports **only** `@hermes/kernel`'s public entry point. Not one
  deep import. Verifiable:

  ```sh
  grep -rn "from '@hermes/kernel/" services/memory/src services/memory/tests   # must print nothing
  ```

- The kernel has **never heard of this package**. `packages/kernel` is
  unmodified by this work and its `dependencies` stay empty. Its zero-dependency
  check (RFC-0001 §3) still prints nothing.

- What is used from the kernel is exactly five things, all of them interfaces or
  tiny helpers: `Clock`, `Logger`, `Brand`, the `Plugin`/`Tool` contracts, and
  the event/snapshot types. Notably `MemoryError` does **not** extend
  `KernelError` (`errors.ts`) — a memory error that were
  `instanceof KernelError` would claim the kernel threw it, which is exactly
  backwards.

**Runtime dependencies: one.** `pg`. Not `catalog:`, because the catalog is for
"versions shared by every package" (pnpm-workspace.yaml) and only this service
talks to Postgres. When the planner needs a database, `pg` moves to the catalog.

Rejected: **an ORM (Drizzle) or query builder (Kysely).** The schema is the most
consequential artefact here and it is worth reading as SQL — indexed as SQL,
reviewed as SQL, explained by `EXPLAIN` as SQL. A builder between the author and
the query planner obscures the one thing most worth seeing, and pgvector support
arrives through a plugin rather than natively. The cost of this decision is that
row→domain mapping is hand-written; it is confined to one file (`mappers.ts`)
and that file is where the three driver traps are documented.

Rejected: **a migration library (node-pg-migrate).** See §5.

## 4. The three memories

### 4.1 Conversation memory is verbatim and is not prunable

`conversation` / `message` hold what was actually said. Nothing summarises,
scores, or forgets them.

This is a hard line. A future change that wants to compress a transcript in
place or delete old messages to save space wants to _write a `summary` memory_,
not to edit these rows. The moment a transcript is lossy, every memory derived
from it becomes unfalsifiable — you can no longer check what someone actually
said.

**`seq` is dense and per-conversation**, and getting it right is the subtlest
thing in the repository layer. The obvious implementation — `SELECT MAX(seq)+1`
then `INSERT` — is a lost-update race: two concurrent appends read the same max,
and one dies on the UNIQUE constraint. Instead `conversation.message_count` is
incremented in a CTE (`appendMessage`), which takes a row lock, so concurrent
appends to _one_ conversation serialise and appends to _different_ conversations
do not contend at all. That is the right trade for Hermes: many subjects, one
thread each. Pinned by a 25-way concurrent test.

Rejected: **a Postgres sequence.** Global and gappy; `seq` must be dense per
conversation.

### 4.2 Memory records are derived, scored, and prunable

`memory_record` is everything above the transcript: facts, preferences,
episodes, summaries, tasks. Five kinds, closed set, because the scorer and
pruner both branch on them (§8) and an open vocabulary makes their weights
unfalsifiable.

Two provenance columns point back at the conversation — with
**`ON DELETE SET NULL`, not `CASCADE`**. A memory outlives the conversation that
produced it. Forgetting where you learned something is normal; forgetting the
thing itself because a transcript was pruned is a bug.

### 4.3 Mission persistence uses the seam the kernel already reserved

RFC-0001 §11.2 does not just permit this, it specifies it: _"the seam is
deliberate and already load bearing: every event carries a snapshot, and
snapshots are plain, serialisable data. A store is a plugin that subscribes —
most likely via `onAny` — and writes."_

`plugin.ts` is that plugin and uses that seam and no other. Three consequences
worth stating:

- **`mission`/`mission_task` are a projection, not a source of truth.** The
  kernel never reads them. Last-write-wins is correct because a snapshot is
  always complete rather than a delta.
- **`mission_event` is an append-only log kept _alongside_ the projection**, not
  instead of it. They answer different questions: "what is true now" in one
  indexed read, versus "what happened, in order" — including events that leave
  no trace in a snapshot, like a retry that later succeeded. It has no FK,
  because an audit log that a constraint can block is not an audit log.
- **Ids are `text`, not `uuid`.** The kernel derives no meaning from an id's
  shape (`ids.ts`), and it ships `sequentialIds()`, which produces `mission_1`.
  A uuid column would import an assumption the kernel explicitly refuses to
  make.

**Errors are not JSON.** `JSON.stringify(new Error('boom'))` is `'{}'` — `name`,
`message`, and `stack` are non-enumerable. A `task:failed` event persisted
naively records that a task failed and _nothing about why_. `flattenError` is
the fix and is the highest-value function in `mission-repository.ts`. It follows
`cause` to a bounded depth, because kernel errors chain (a `PluginError` wraps
what the plugin threw) and because a cause chain can be cyclic.

**Timestamps come from the snapshot, never `now()`.** The kernel's clock is
injectable and a `TestClock` starts at 0. Recording wall time would make
persisted history disagree with the kernel that produced it. `recorded_at` is
the one honest `now()`: it is a fact about the database, not about the mission.

**Persistence never breaks a mission.** The plugin's listener catches everything
and logs. A database being down must not stop the assistant from working —
persistence is an observer of the system, not a participant in it. Pinned by a
test that runs a real mission against a `MemoryService` whose every query
rejects.

## 5. Migrations

A ~200-line hand-rolled runner (`db/migrator.ts`) instead of a dependency, for
the same reason the kernel has none: this is the code that decides what shape
the data is in, and it is worth being able to read all of it. It does four
things a naive runner gets wrong:

1. **It locks.** `pg_advisory_xact_lock` before reading the ledger. Two
   processes booting at once (an API and a Telegram app; two CI jobs) would
   otherwise both see the same pending list and both apply it. Pinned by a
   concurrent test.
2. **It checksums.** An applied migration whose file later changed is drift, and
   drift is silent: the code expects a schema the database does not have. That
   is an **error**, not a warning. Line endings are normalised so a Windows
   checkout is not drift; nothing else is.
3. **It is atomic.** See below.
4. **It records.** `schema_migrations` is the ledger and nothing else is. It is
   not itself a migration, for the obvious reason.

**Why one transaction for the whole run.** Postgres has transactional DDL, so
every migration in a run commits or rolls back together. This buys the property
that matters most for a schema: **there is no such thing as half-migrated.** The
fix for a failure is always "correct the file and re-run", never "work out which
of these five applied and hand-repair the rest".

The cost: a failing run wastes the work before it, and holds the lock
throughout. Both are irrelevant at this scale and would stop being irrelevant
the moment a migration needs to rewrite a large table or run
`CREATE INDEX CONCURRENTLY` — which cannot run in a transaction at all. **If
that day comes, the honest change is a per-migration transaction plus a
session-level advisory lock.** This paragraph is the argument to beat.

`repair: true` is the escape hatch for the one case where drift is legitimate —
migration 0004 is conditional, so installing pgvector later means the same
unchanged file must run again. Every migration is written to be idempotent
(`IF NOT EXISTS`, `DO $$` guards) so that this is safe. It is opt-in because
"just re-run it" is exactly the reflex that turns a drift warning into a dropped
table.

Rejected: **node-pg-migrate.** It would own less code but bring its own
conventions on top of the SQL we would write anyway, and the four properties
above are the entire value — they are worth understanding rather than trusting.

## 6. pgvector-ready, not pgvector-dependent

**This is the decision most likely to be misread as a compromise, so it is worth
being precise about.**

The fact that forced it: **the native Homebrew Postgres 17 that HermesOS
develops against has no `vector` extension available.** Only `pgcrypto`,
`citext`, and `pg_trgm` are installed
(`infrastructure/postgres/init/001-extensions.sql`), and `vector` is not even in
`pg_available_extensions`. Meanwhile `docker-compose.yml` names
`pgvector/pgvector:pg17` as a swap-in, and production will use it.

So the schema must produce a **working memory service on both**, from one set of
migration files, or the ledger forks and the two environments stop being
comparable. The design:

- **`memory_embedding.embedding real[]` is the source of truth, always.**
  Portable, no extension required, and `real[]` casts directly to `vector`.
- **Migration 0004 is conditional.** Where the extension exists it adds
  `embedding_v vector(768)`, backfills by casting, and builds an HNSW index.
  Where it does not, it raises a notice and does nothing. Pinned by a test
  asserting the column exists **if and only if** the extension does — which
  passes on both kinds of cluster.
- **The index is chosen by probing, not by configuration**
  (`createSemanticIndex`). A flag would be a second source of truth about
  something the database already knows, and would be wrong the first time
  someone installed the extension without editing `.env`.
- **Both implementations are covered by the same tests.** `retrieval.test.ts`
  exercises `BruteForceIndex` on a dev machine and `PgVectorIndex` on a pgvector
  cluster from identical assertions, and one test compares them directly. If
  they ever disagree about what "nearest" means, a test fails. **That is what
  makes the fallback trustworthy rather than theoretical.**

`BruteForceIndex` is honest about what it is: O(memories × dimensions) per query
with the working set crossing the wire. At personal-assistant scale — thousands
of memories per subject — that is a few milliseconds. `maxCandidates` (default
5,000) bounds the damage, and crossing it **logs a warning naming the subject**,
because exceeding it means results are silently incomplete. That warning is the
signal to install pgvector.

**Why HNSW over IVFFlat**: IVFFlat needs a populated, representative table at
build time to cluster well, and this index is built on an empty one. HNSW has no
training step and is correct from the first row — which matters more here than
IVFFlat's smaller footprint at a scale of one person's memories.

**Why 768 is hardcoded**: pgvector requires a fixed dimension per column and SQL
cannot parameterise a type. 768 is `nomic-embed-text`, the model in
`OLLAMA_MODELS`. It is the one place the schema commits to a model, and it is
survivable precisely because `memory_embedding` is keyed by `(memory_id, model)`
and `real[]` carries its own `dimensions`: adopting a model of another width
needs a new ANN index, not a reshape of the data. A provider whose width does
not match falls back to brute force, with a warning.

Rejected: **install pgvector and require it.** Simpler code — one index path, no
fallback — but it makes "semantic retrieval works only if you first install an
extension" a property of the subsystem the whole assistant depends on, and it
makes CI require it too.

Rejected: **assume pgvector and skip the tests locally.** Least code, but Memory
would ship with its retrieval path never having been executed.

## 7. Embeddings

`EmbeddingProvider` is three members. It is **batch-first** (`embed(texts)`)
because every real provider is: a single-item method invites a caller to loop,
and a loop over an HTTP embedding endpoint is the difference between one request
and a thousand. `embedOne` exists as a free function so the cheap path is not
the default one.

Two implementations ship:

- **`OllamaEmbeddingProvider`** — the production one. `fetch` against
  `/api/embed`, no SDK. Everything injected; no `process.env` read, per RFC-0001
  §3.
- **`HashEmbeddingProvider`** — deterministic, offline, and **not a language
  model**. "car" and "automobile" are as unrelated to it as "car" and
  "xylophone".

`HashEmbeddingProvider` deserves its justification because it looks like a toy.
Tests for retrieval, importance, and pruning need vectors. Getting them from
Ollama would make the suite depend on a running server, a pulled model, and a
GPU's mood — slow, flaky, unrunnable in CI — and `nomic-embed-text` offers no
cross-version stability guarantee, so "similar texts rank higher" would be a bet
on a third party's weights. The hash provider guarantees exactly what those
tests need: determinism, and that texts sharing words score higher than texts
that do not. Whether ranking is _smart_ is the model's job; that ranking _works_
is the code's, and that is what is under test.

The sign bit drawn from the hash is not incidental. Without it every vector
lands in the positive orthant, cosine sits near 1.0 across the corpus, and
ranking is noise — which would still pass a naive one-pair ordering test. There
is a test for that specifically.

**Embedding failure does not fail the write** (`MemoryService.remember`). The
record commits first; a failed embedding is logged. The alternative is that
Ollama being down means Hermes **silently stops remembering anything** —
unrecoverable — versus an un-embedded memory, which is still found lexically and
can be backfilled. `findUnembedded` and `backfillEmbeddings` are the repair
path, and their existence is what makes this an honest trade rather than a way
to lose data quietly.

## 8. Judgement: importance, ranking, pruning

Three interfaces, three replaceable defaults. All scores are in `[0,1]` because
they are combined in weighted sums; a scorer returning 7 would not error, it
would quietly dominate every weight in the system.

### 8.1 Importance

`HeuristicImportanceScorer` is a per-kind prior plus a pile of weak lexical
signals. **Every signal is ≤0.1 and additive, deliberately**: no single
heuristic can move a memory more than a nudge, so being wrong about one costs a
rounding error rather than an eviction. The prior does the work.

The design does not try to be right — any scorer is wrong; a heuristic cannot
know that a throwaway remark was the important part. It tries to be
**correctable**:

- an explicit score from the caller always wins;
- `pinned` bypasses scoring entirely;
- **usage feeds back.** `retentionScore` reads `lastAccessedAt ?? createdAt`, so
  _reading_ a memory keeps it alive. That is the mechanism by which the scorer's
  mistakes are corrected by use, with nobody intervening. It is the single most
  important line in `importance.ts`.

The per-kind ordering (preference > fact > task > summary > episode) is the
claim; the exact numbers are not, and the tests assert only the ordering.

Decay is exponential, not linear, because linear decay hits zero and stays there
— a 40-day-old memory and a 10-year-old one would rank identically. There must
always be an ordering.

### 8.2 Ranking

A pure semantic index answers "what is closest to this query vector", which is
not "what should this agent be told". The gap is where assistants disappoint:
the nearest memory is often a stale episode sharing vocabulary, while the
standing preference that governs the answer sits three places down.

`HybridRetriever` blends similarity (0.6), importance (0.2), recency (0.15), and
usage (0.05), and unions in **lexical (pg_trgm) hits** — which is what makes
recall work for exact tokens an embedding smooths away: names, ids, "bay 14".
Similarity dominates and should: a retriever returning important-but-irrelevant
memories is worse than useless, it is confidently off-topic.

Candidates are over-fetched 4× before ranking. Without that, re-ranking could
only reorder what cosine already chose, and an important memory ranked 11th
could never surface.

**The weights are defaults, not truths.** They are the first thing to tune when
recall feels wrong.

### 8.3 Pruning

The most dangerous code in the service, and the design says so at every level:

- **Soft delete.** `forget` sets `forgotten_at`. A pruning bug is recoverable by
  clearing a column, not by restoring a backup. Hard deletion (`purgeForgotten`)
  is separate, explicit, takes an age, and is never automatic.
- **Plan, then apply.** `plan()` is pure and returns what _would_ be forgotten,
  with a reason and the content per memory. That makes the dangerous decision
  synchronously testable with no database, and lets a host log or approve a
  plan. `dryRun` is the right way to introduce pruning to a database that
  matters.
- **Pinned is untouchable.** No score, no age, no quota evicts a pinned memory.
  A subject over quota entirely in pinned memories **stays over quota** — the
  alternative is a quota that overrides an explicit "never forget this".
- **Grace period.** Nothing newer than 24h is judged. A fresh memory has no
  usage history and its importance is a guess; judging it immediately judges it
  on the least information the system will ever have.

Three passes, cheapest and most certain first: expired (the caller told us the
shelf life), decayed (the scorer's opinion, aged), over-quota (forgets memories
that are _fine_, purely because there are too many — which is why it runs last).

An expired memory is forgotten **even if pinned**: an explicit expiry is the
caller being specific, and it outranks the blanket "keep this". Otherwise
`pinned` becomes a way to accidentally immortalise something declared temporary
at birth.

One number worth internalising: **importance contributes `importance × 0.5`
unconditionally**, so a memory at importance ≥ 0.3 has a retention floor above
the 0.15 default threshold and **can never decay away**, however old. That is
"importance leads" working as designed. It surprised the author
mid-implementation (a test asserted otherwise and was wrong), so it is written
down here.

## 9. Known limitations and extension points

Ordered by how likely you are to hit them.

### 9.1 Mission rehydration is still not solved

RFC-0001 §11.2 says: _"What is *not* yet solved, and would need design:
rehydrating a mission mid-flight after a crash... That is an
at-least-once/idempotency conversation, not a kernel feature. Start it in a new
RFC."_

**This RFC does not start it.** Missions are now durable — you can ask what was
running when the process died (`listByState('running')`, which is why it avoids
an N+1) — but nothing resumes them. `Mission` has no constructor from a
snapshot, and a task that was `running` when the process died has genuinely
unknown status: did the effect happen? Answering that needs idempotency keys on
tools, which is a change to the _tool contract_, not to this service.

That remains a separate RFC. Persisting the snapshots is its precondition, and
that precondition is now met.

### 9.2 The audit log costs scheduler latency

`emit` awaits its listeners (RFC-0001 §5.7), so one INSERT per event is on the
scheduler's path. That is the backpressure the kernel designed for, not a bug —
but it is real, and it is why `auditLog` is a switch. A host running
high-frequency missions may want the projection without the full log.

### 9.3 `BruteForceIndex` does not scale, on purpose

See §6. It is correct and bounded, not fast. The fix is installing pgvector, and
the warning tells you when.

### 9.4 The heuristics are placeholders

`HeuristicImportanceScorer` is regex over content. It is meant to look like a
placeholder for a model, and replacing it is one object at a composition root.
The interfaces are the deliverable; the defaults are scaffolding good enough to
run on.

### 9.5 No cross-subject memory

Every read is scoped by `subject`, which is the isolation boundary. There is no
way to ask "what do I know about X across everyone", and no notion of a shared
fact. That is deliberate for a personal assistant and would need real thought
about access control before changing.

### 9.6 Summaries are not generated

The `summary` kind exists and is scored and pruned correctly, but nothing writes
one. Rolling a long conversation into a summary memory is the obvious next use
of the transcript, and it needs a model — so it belongs above this service, or
in a plugin, calling `remember({ kind: 'summary' })`.

### 9.7 No retrieval evaluation

There is no golden set and no measure of whether recall is _good_ — only that it
works. The weights in §8.2 are therefore chosen by argument, not by evidence. A
retrieval benchmark is the highest-value thing anyone could add here.

## 10. Testing strategy

279 tests. `pnpm --filter @hermes/memory test`.

The strategy follows the architecture, and mirrors the kernel's (RFC-0001 §12):

- **Judgement is tested purely and synchronously.** `importance.test.ts` and
  `pruning.test.ts` drive the entire scoring and eviction algebra with no
  database — the payoff for keeping `score()` and `plan()` pure. This is where
  the subtle rules are cheapest to pin down.
- **They assert orderings and invariants, not numbers.** A test asserting a fact
  scores 0.70 would fail the moment someone tuned a weight, while saying nothing
  about whether the scorer got better. What must survive any retuning is that a
  preference outranks an episode and that scores stay in `[0,1]`.
- **Repository tests are integration tests by necessity.** That `seq` stays
  dense under concurrency, that a cascade fires, that a CTE is atomic — these
  are properties of the _database_, and a fake would only prove the fake agrees
  with my assumptions about it.
- **Mission persistence is driven by a real kernel.** A real `Runtime`, real
  plugins, real missions, real events. The claim under test is "a store is a
  plugin that subscribes", and the only way to test it is to be that plugin.
- **Retrieval tests pass on both cluster kinds.** See §6.

**Isolation: a private schema per test file.** `withTestDatabase()` creates
`test_<random>`, migrates into it, drops it after. No second database, no
CREATEDB rights, no Docker — the repo deliberately does not require Docker ("the
default stack is intentionally EMPTY"), and Testcontainers would change that.
Tests skip with an explanation when `DATABASE_URL` is unset, so a contributor
without a database still gets a green run of the pure tests.

**Determinism.** `TestClock` for time; `HashEmbeddingProvider` for vectors;
explicit tiebreaks in ranking. One test earned its comment the hard way:
`recall` touches memories fire-and-forget, so a test that advances the clock
immediately afterwards races the write. That is a genuinely flaky test, and the
fix is to wait on the observable, never to sleep.

---

## 11. Invariants — the short list

If you change one of these, you are changing the design, not fixing a bug.

1. **`services/memory` imports only `@hermes/kernel`'s public entry.** No deep
   imports. The kernel does not know this package exists.
2. **The schema works without pgvector.** `real[]` is the source of truth;
   migration 0004 stays conditional; the index is chosen by probing.
3. **Conversation memory is verbatim.** Nothing summarises or deletes it in
   place.
4. **Pruning is a soft delete, and pinned memories are never evicted by score,
   age, or quota.**
5. **`plan()` and `score()` are pure.** Pruning re-derives and must agree.
6. **Persistence never breaks a mission.** The plugin catches everything.
7. **Errors are flattened before they reach jsonb.** `JSON.stringify(error)` is
   `'{}'`.
8. **Timestamps are epoch millis from an injected `Clock`**, never `Date.now()`,
   and mission timestamps come from the snapshot.
9. **Applied migrations are immutable.** Drift is an error.
10. **Every judgement is an interface with a replaceable default.**
