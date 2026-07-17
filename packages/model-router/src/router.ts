/**
 * The router — capability selection plus fallback across providers.
 *
 * {@link route} is the engine: given ordered candidates and a way to invoke one,
 * it tries them in turn, **falling back on a retryable failure and stopping on a
 * definitive one**. That single rule is the whole value — a rate-limited or
 * unavailable provider is worth trying the next one for; an invalid request or a
 * content filter is not, and hammering the chain with it just fails N times and
 * bills for it (the reasoning the `ModelError.retryable` flag exists for).
 *
 * {@link RoutingChatModel} wraps that engine as a `ChatModel` / `ToolCallingModel`,
 * so a caller (the agent framework's reasoner) holds one model and never knows a
 * fallback chain sits behind it. It selects candidates by capability, so adding a
 * provider is registering it — no caller changes.
 */

import { noopLogger, type Logger } from '@hermes/kernel';
import type {
  ChatModel,
  Model,
  ModelInfo,
  ModelMessage,
  ModelOptions,
  ModelResponse,
  ToolCallingModel,
  ToolCallingOptions,
  ToolDefinition,
} from '@hermes/model';
import {
  AllFailedError,
  asModelError,
  NoCandidatesError,
  type RouteAttempt,
} from './errors.js';
import { type ModelRegistry } from './registry.js';
import { selectCandidates, type RouteCriteria } from './selection.js';

export interface RouteOptions {
  readonly signal?: AbortSignal;
  /** Called after each failed attempt, in try-order. For logging and metrics. */
  readonly onAttempt?: (attempt: RouteAttempt) => void;
}

/**
 * Try `candidates` in order, invoking each until one succeeds.
 *
 * Falls back only on a *retryable* `ModelError`; a non-retryable failure (or any
 * non-`ModelError`) is thrown straight through, because it is a definitive answer
 * the next provider would give too. Throws {@link NoCandidatesError} for an empty
 * list and {@link AllFailedError} when every candidate failed retryably.
 */
export async function route<M extends Model, R>(
  candidates: readonly M[],
  invoke: (model: M) => Promise<R>,
  options: RouteOptions = {},
): Promise<R> {
  if (candidates.length === 0) {
    throw new NoCandidatesError('no registered model matched');
  }

  const attempts: RouteAttempt[] = [];
  for (const model of candidates) {
    options.signal?.throwIfAborted();
    try {
      return await invoke(model);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const attempt: RouteAttempt = {
        model: model.info.name,
        provider: model.info.provider,
        error,
      };
      attempts.push(attempt);
      options.onAttempt?.(attempt);

      const modelError = asModelError(err);
      // Definitive failure — this provider's answer is the answer. Don't burn the
      // rest of the chain on a request that is wrong everywhere.
      if (!modelError?.retryable) throw err;
    }
  }
  throw new AllFailedError(attempts);
}

export interface RoutingChatModelOptions {
  /** Default criteria applied to every call (a per-call `extra.route` overrides it). */
  readonly criteria?: RouteCriteria;
  readonly logger?: Logger;
  /** The router's own `info.name`. Default `router`. */
  readonly name?: string;
}

/**
 * A `ChatModel` / `ToolCallingModel` that routes to registered providers.
 *
 * Its `chat` selects models declaring `chat`; `chatWithTools` selects models
 * declaring `tools`. A caller can steer one call by passing
 * `options.extra.route` — a {@link RouteCriteria} merged over the defaults —
 * without any bespoke API.
 */
export class RoutingChatModel implements ToolCallingModel {
  readonly #registry: ModelRegistry;
  readonly #criteria: RouteCriteria;
  readonly #logger: Logger;
  readonly #name: string;

  constructor(registry: ModelRegistry, options: RoutingChatModelOptions = {}) {
    this.#registry = registry;
    this.#criteria = options.criteria ?? {};
    this.#logger = (options.logger ?? noopLogger).child({ component: 'model-router' });
    this.#name = options.name ?? 'router';
  }

  get info(): ModelInfo {
    const toolCapable = this.#registry.byFeatures({ tools: true }).length > 0;
    return {
      name: this.#name,
      provider: 'router',
      supports: { chat: true, tools: toolCapable, streaming: false },
    };
  }

  async chat(
    messages: readonly ModelMessage[],
    options?: ModelOptions,
  ): Promise<ModelResponse> {
    const candidates = this.#candidates({ chat: true }, options).filter(isChatModel);
    return route(
      candidates,
      (model) => model.chat(messages, options),
      this.#routeOptions(options),
    );
  }

  async chatWithTools(
    messages: readonly ModelMessage[],
    tools: readonly ToolDefinition[],
    options?: ToolCallingOptions,
  ): Promise<ModelResponse> {
    const candidates = this.#candidates({ chat: true, tools: true }, options).filter(
      isToolCallingModel,
    );
    return route(
      candidates,
      (model) => model.chatWithTools(messages, tools, options),
      this.#routeOptions(options),
    );
  }

  #candidates(
    features: RouteCriteria['features'],
    options?: ModelOptions,
  ): readonly Model[] {
    const perCall = readRouteOverride(options);
    const criteria: RouteCriteria = {
      ...this.#criteria,
      ...perCall,
      // Capability requirements are the router's, not the caller's to drop; merge
      // the method-level features over whatever either side asked for.
      features: { ...this.#criteria.features, ...perCall?.features, ...features },
    };
    return selectCandidates(this.#registry, criteria);
  }

  #routeOptions(options?: ModelOptions): RouteOptions {
    const onAttempt = (attempt: RouteAttempt): void => {
      this.#logger.warn('model attempt failed; falling back', {
        model: attempt.model,
        provider: attempt.provider,
        error: attempt.error.message,
      });
    };
    return options?.signal === undefined
      ? { onAttempt }
      : { onAttempt, signal: options.signal };
  }
}

function readRouteOverride(options?: ModelOptions): RouteCriteria | undefined {
  const route = options?.extra?.['route'];
  return isRouteCriteria(route) ? route : undefined;
}

function isRouteCriteria(value: unknown): value is RouteCriteria {
  return typeof value === 'object' && value !== null;
}

/** A model with a callable `chat` method. */
export function isChatModel(model: Model): model is ChatModel {
  return typeof (model as Partial<ChatModel>).chat === 'function';
}

/** A model with a callable `chatWithTools` method. */
export function isToolCallingModel(model: Model): model is ToolCallingModel {
  return typeof (model as Partial<ToolCallingModel>).chatWithTools === 'function';
}
