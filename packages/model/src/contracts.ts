/**
 * The model contracts — what an AI provider promises, in one file.
 *
 * ## Why this is its own package
 *
 * These interfaces are needed by three groups who must not depend on each other:
 * the **agent framework** that calls a model, the **providers** (Ollama, Claude,
 * OpenAI, Gemini) that implement one, and the **model router** that picks between
 * them. If the interfaces lived in the agent framework, an Ollama provider —
 * which is an HTTP client and nothing more — would have to import a reasoning
 * framework to declare its own shape. That is the dependency graph pointing
 * outward, and the whole platform rule is that it points inward.
 *
 * So the contracts sit below all three, with **no dependencies at all**, not even
 * on the kernel. Everything above depends on this; this depends on nothing.
 *
 * ## What is deliberately not here
 *
 * No implementations. No HTTP, no SDK, no retry, no key handling. A package of
 * contracts that also had a favourite provider would stop being a contract and
 * start being a preference.
 *
 * No prompt templates and no message formatting. Those are a *consumer's*
 * business — the agent framework has opinions about how to talk to a model, and
 * baking them in here would force every provider to inherit them.
 */

/** Who said something. The four roles every chat model in use today agrees on. */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * One message in a conversation with a model.
 *
 * Deliberately *not* `@hermes/memory`'s `Message`, though they look alike. That
 * one is a durable record of what a human and the assistant actually said, with
 * an id, a conversation, and a sequence number. This one is a transient prompt
 * fragment that may never be stored and often did not come from anybody — a
 * system instruction, a tool result, a summary the agent synthesised. Fusing them
 * would make every prompt fragment look like something the user said.
 */
export interface ModelMessage {
  readonly role: MessageRole;
  readonly content: string;
  /**
   * Tool calls the model asked for. Only meaningful on an `assistant` message.
   *
   * The model *requests*; it does not execute. That split is the whole of the
   * agent framework's "agents never execute tools directly", and it starts here.
   */
  readonly toolCalls?: readonly ToolCall[];
  /**
   * Which tool call this message answers. Required on a `tool` message.
   *
   * A tool result with no id is unattributable once two tools run in parallel,
   * and every provider that supports parallel calls requires it.
   */
  readonly toolCallId?: string;
  /** Optional speaker label, where a provider supports one. */
  readonly name?: string;
}

/**
 * A model's request to run a tool.
 *
 * `args` is `unknown`, not `Record<string, unknown>`: it arrived as text from a
 * model and has not been validated by anything yet. Typing it as an object would
 * be this package asserting something it did not check, and the caller narrowing
 * it with a validator is the entire point of the kernel's `Validator` seam.
 */
export interface ToolCall {
  /** Correlates the call with its result. Unique within one assistant turn. */
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

/**
 * What a model may be told it can do.
 *
 * Structurally close to the kernel's `Tool` minus `execute` — which is the point:
 * a model is told *that* a capability exists and never handed the ability to run
 * it. `parameters` is an opaque JSON Schema value rather than a typed structure,
 * because every provider wants JSON Schema and none of them agree on the dialect,
 * so the one thing this package must not do is pick one.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments. Passed through to the provider untouched. */
  readonly parameters?: unknown;
}

/** What it cost. Reported when a provider knows; absent when it does not. */
export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Prompt tokens served from a provider-side cache, where reported. */
  readonly cachedTokens?: number;
}

/** Why a model stopped. */
export type StopReason =
  /** It finished its answer. */
  | 'stop'
  /** It ran into `maxTokens`. The answer is truncated and probably unusable. */
  | 'length'
  /** It wants tools run before it continues. */
  | 'tool_calls'
  /** A provider-side safety system stopped it. */
  | 'filtered'
  /** The caller aborted. */
  | 'cancelled';

/**
 * What every model call may be given.
 *
 * Everything is optional and no default is stated here. A default temperature in
 * a contract would be this package having an opinion about a value that only
 * makes sense per model, and a caller reading `temperature ?? 0.7` in an
 * interface would reasonably assume every provider honoured it. Providers state
 * their own defaults; consumers state their own intent.
 */
export interface ModelOptions {
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly stop?: readonly string[];
  /**
   * Honouring it is not optional for a provider.
   *
   * A model call is the slowest and most expensive thing in the system, so a
   * provider that ignores its signal holds a step — and therefore a kernel
   * concurrency slot — long after the caller has gone. That is the same
   * cooperative-cancellation contract the kernel states (RFC-0001 §11.1),
   * inherited rather than reinvented.
   */
  readonly signal?: AbortSignal;
  /**
   * Provider-specific knobs, passed through untouched.
   *
   * The escape hatch that keeps this interface from growing a field every time a
   * provider ships one. A consumer setting this has deliberately coupled itself
   * to a provider and knows it, which is better than the interface pretending
   * every provider has `topK`.
   */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** What came back. */
export interface ModelResponse {
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly stopReason: StopReason;
  /** Which model actually answered. May differ from the one asked for. */
  readonly model: string;
  readonly usage?: TokenUsage;
}

/** Identity and limits, for a router choosing between models. */
export interface ModelInfo {
  readonly name: string;
  /** Who serves it: `ollama`, `anthropic`, `openai`, `google`. */
  readonly provider: string;
  /** Total context window in tokens, where known. */
  readonly contextWindow?: number;
  /** What it can do. A router reads this rather than matching on model names. */
  readonly supports: ModelFeatures;
}

/**
 * What a model can do, declared rather than inferred.
 *
 * A router that inferred features from a model *name* would be a table of string
 * prefixes that is wrong the day a provider ships a new one. Asking the provider
 * is the only version of this that keeps working.
 */
export interface ModelFeatures {
  readonly chat: boolean;
  readonly tools: boolean;
  readonly streaming: boolean;
  readonly vision?: boolean;
  /** Can it be asked to return JSON matching a schema? */
  readonly structuredOutput?: boolean;
}

/** The root of every model contract. Everything below is `Model` plus a verb. */
export interface Model {
  readonly info: ModelInfo;
}

/**
 * A model that holds a conversation.
 *
 * The interface the agent framework's `LlmReasoner` is written against, and the
 * only one it needs. Note what is absent: no `systemPrompt` field, no history
 * management, no memory. A `ChatModel` is a pure function from messages to a
 * response, and every provider can be that honestly.
 */
export interface ChatModel extends Model {
  chat(
    messages: readonly ModelMessage[],
    options?: ModelOptions,
  ): Promise<ModelResponse>;
}

/**
 * A model that continues text.
 *
 * Separate from {@link ChatModel} rather than folded into it, because they are
 * genuinely different capabilities: a base model completes and cannot converse,
 * and an instruct model converses and completes badly. A provider implements
 * whichever it honestly is, and one that implements both says so by implementing
 * both.
 */
export interface CompletionModel extends Model {
  complete(prompt: string, options?: ModelOptions): Promise<ModelResponse>;
}

/**
 * A model that can be told about tools and will ask for them.
 *
 * It **requests** — `ModelResponse.toolCalls` — and never executes. Nothing in
 * this package can execute anything, which is what makes "agents never execute
 * tools directly" structural rather than a rule someone has to remember.
 *
 * Separate from `ChatModel` because tool support is the feature providers differ
 * on most, and a `ChatModel` that threw on `tools` would be a contract lying
 * about itself.
 */
export interface ToolCallingModel extends ChatModel {
  chatWithTools(
    messages: readonly ModelMessage[],
    tools: readonly ToolDefinition[],
    options?: ToolCallingOptions,
  ): Promise<ModelResponse>;
}

export interface ToolCallingOptions extends ModelOptions {
  /**
   * `auto` — the model decides. `none` — do not call tools. `required` — call at
   * least one. `{ name }` — call this one.
   *
   * Named rather than boolean because "make it use a tool" and "make it use *this*
   * tool" are different asks, and a boolean would force a caller wanting the
   * second to prompt for it and hope.
   */
  readonly toolChoice?: 'auto' | 'none' | 'required' | { readonly name: string };
}

/** One piece of a streamed response. */
export type ModelChunk =
  /** More text. `delta` is the increment, never the accumulated string. */
  | { readonly kind: 'text'; readonly delta: string }
  /**
   * A tool call, complete.
   *
   * Whole rather than streamed in fragments: providers stream tool-call JSON
   * character by character, and a consumer that had to reassemble it would
   * reimplement a partial-JSON parser per provider. Buffering that is the
   * provider's job, because the provider is the only one that knows its own
   * fragmentation.
   */
  | { readonly kind: 'tool_call'; readonly call: ToolCall }
  /** The end. Always the last chunk, exactly once. */
  | { readonly kind: 'done'; readonly response: ModelResponse };

/**
 * A model that answers incrementally.
 *
 * An `AsyncIterable` rather than a callback or an `EventEmitter`: `for await`
 * gives back `try`/`finally`, `break`, and — crucially — backpressure, because
 * the provider cannot run ahead of a consumer that has not asked for the next
 * chunk. A callback API has none of those and leaks the first time a consumer
 * throws.
 */
export interface StreamingModel extends Model {
  stream(
    messages: readonly ModelMessage[],
    options?: ModelOptions,
  ): AsyncIterable<ModelChunk>;
}

/**
 * A model that turns text into a vector.
 *
 * ## Why this is a superset of `@hermes/memory`'s `EmbeddingProvider`
 *
 * Memory already declares that interface, and this one deliberately **does not
 * import it**: this package has no dependencies, and taking one on the memory
 * service would drag Postgres and `pg` into an Ollama client that wanted an HTTP
 * call. Providers depend on these contracts; they must not depend on a database.
 *
 * So it is redeclared — but as a strict superset, field for field and signature
 * for signature, with `info` added. The direction that buys is the one that
 * matters: **every `EmbeddingModel` is already an `EmbeddingProvider`**, so a
 * host hands the same object to a model router and to `MemoryService` with no
 * adapter between them. The reverse does not hold, and should not: a bare
 * embedder has no `ModelInfo` and a router has nothing to route on.
 *
 * That is why `embed` takes an `AbortSignal` rather than {@link ModelOptions},
 * which would have been more symmetrical with the rest of this file and would
 * have quietly broken the compatibility this exists for — `temperature` means
 * nothing to an embedder anyway. The one seam where two packages must agree is
 * worth an asymmetry.
 *
 * `services/agent/tests/embedding-compatibility.test.ts` pins it, because it is
 * the only place both interfaces are visible at once. If either drifts, that
 * test fails rather than a host discovering it at a call site.
 */
export interface EmbeddingModel extends Model {
  /**
   * Model identifier. Memory stores this verbatim as part of a primary key, so
   * it decides what counts as the same vector space — two models producing
   * incomparable vectors must never share a name.
   */
  readonly model: string;
  /** The vector's width. Fixed per model; a store indexes on it. */
  readonly dimensions: number;
  embed(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly (readonly number[])[]>;
}
