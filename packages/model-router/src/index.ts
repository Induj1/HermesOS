/**
 * @hermes/model-router — capability-based routing and fallback across model
 * providers.
 *
 * Register the models a deployment has; hold a {@link RoutingChatModel} that
 * presents as one `ChatModel` / `ToolCallingModel`. It selects a provider by
 * declared capability and falls back to the next on a *retryable* failure,
 * stopping on a definitive one — so a caller (the agent's reasoner) never knows a
 * fallback chain sits behind the model it holds, and adding a provider is just
 * registering it.
 *
 * ```ts
 * import { ModelRegistry, RoutingChatModel } from '@hermes/model-router';
 *
 * const registry = new ModelRegistry()
 *   .register(localLlama)   // prefer the cheap local model…
 *   .register(claude);      // …fall back to the API when it is unavailable
 *
 * const model = new RoutingChatModel(registry);
 * const answer = await model.chat(messages);          // routed + fallback
 * await model.chat(messages, { extra: { route: { models: ['claude'] } } }); // pin one call
 * ```
 *
 * See `docs/rfcs/RFC-0014-model-router.md` for the design.
 */

export { ModelRegistry, supportsAll } from './registry.js';

export { selectCandidates } from './selection.js';
export type { RouteCriteria } from './selection.js';

export { route, RoutingChatModel, isChatModel, isToolCallingModel } from './router.js';
export type { RouteOptions, RoutingChatModelOptions } from './router.js';

export {
  RouterError,
  NoCandidatesError,
  AllFailedError,
  asModelError,
} from './errors.js';
export type { RouterErrorCode, RouteAttempt } from './errors.js';

export { FakeChatModel, chatOnly, response } from './fake-model.js';
export type { FakeChatModelOptions, Outcome } from './fake-model.js';
