/**
 * @hermes/model — what an AI provider promises.
 *
 * Contracts and nothing else: no HTTP, no SDK, no keys, no favourite provider.
 * This package has **zero dependencies**, not even on the kernel, and everything
 * that touches a model depends on it rather than on each other.
 *
 * ```
 *            ┌──────────────────┐
 *            │  @hermes/model   │   (contracts; no dependencies)
 *            └────────┬─────────┘
 *        ┌────────────┼────────────┐
 *        ▼            ▼            ▼
 *   providers     model router   @hermes/agent
 *   (ollama,      (picks one)    (calls one)
 *    claude, …)
 * ```
 *
 * The arrangement is the point. An Ollama provider is an HTTP client; it should
 * not have to import a reasoning framework to declare its own shape. A router
 * picking between providers should not depend on the thing that will call it.
 * Every one of those depends on this, and this depends on nothing.
 *
 * ## The one rule
 *
 * **Nothing here can execute anything.** A model *requests* tools
 * ({@link ToolCall}) and is *told* they exist ({@link ToolDefinition}); it is
 * never handed the ability to run one. That is what makes "agents never execute
 * tools directly" structural rather than a rule someone has to remember.
 *
 * See `docs/rfcs/RFC-0005-agent-framework.md` §4 for why it is shaped this way.
 */

export type {
  ChatModel,
  CompletionModel,
  EmbeddingModel,
  MessageRole,
  Model,
  ModelChunk,
  ModelFeatures,
  ModelInfo,
  ModelMessage,
  ModelOptions,
  ModelResponse,
  StopReason,
  StreamingModel,
  TokenUsage,
  ToolCall,
  ToolCallingModel,
  ToolCallingOptions,
  ToolDefinition,
} from './contracts.js';

export {
  assistant,
  isTruncated,
  system,
  toolResult,
  totalUsage,
  user,
  wantsTools,
} from './messages.js';

export {
  AuthenticationFailedError,
  ContentFilteredError,
  ContextTooLongError,
  InvalidRequestError,
  isRetryable,
  ModelError,
  ModelTimeoutError,
  ModelUnavailableError,
  RateLimitedError,
  toError,
} from './errors.js';
export type { ModelErrorCode } from './errors.js';
