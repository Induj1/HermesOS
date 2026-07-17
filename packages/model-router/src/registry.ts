/**
 * A registry of models, indexed for the router to choose from.
 *
 * A plain map by name plus the two lookups routing actually needs: by capability
 * (a router picks a *tool-calling* model without knowing which providers offer
 * one) and by provider (a caller can pin a request to one vendor). It holds
 * `Model`s — the common base — and narrows on retrieval, because a registry that
 * only accepted `ChatModel`s could not also hold the embedding models a mixed
 * deployment registers.
 */

import type { Model, ModelFeatures, ModelInfo } from '@hermes/model';

export class ModelRegistry {
  readonly #models = new Map<string, Model>();

  /**
   * Register a model under its `info.name`.
   *
   * Re-registering a name replaces it — a deployment swapping a model in is a
   * normal act, not an error, and throwing would make a hot reload impossible.
   */
  register(model: Model): this {
    this.#models.set(model.info.name, model);
    return this;
  }

  /** Register many at once. */
  registerAll(models: Iterable<Model>): this {
    for (const model of models) this.register(model);
    return this;
  }

  /** The model registered under `name`, or undefined. */
  get(name: string): Model | undefined {
    return this.#models.get(name);
  }

  /** True when a model is registered under `name`. */
  has(name: string): boolean {
    return this.#models.has(name);
  }

  /** Every registered model, in registration order. */
  list(): readonly Model[] {
    return [...this.#models.values()];
  }

  /** The registered `ModelInfo`s — what a router or a UI enumerates. */
  infos(): readonly ModelInfo[] {
    return this.list().map((m) => m.info);
  }

  /** Models a given provider serves. */
  byProvider(provider: string): readonly Model[] {
    return this.list().filter((m) => m.info.provider === provider);
  }

  /**
   * Models supporting every feature set to `true` in `required`.
   *
   * A feature left unset (or `false`) in `required` is not demanded — asking for
   * `{ tools: true }` returns models that call tools, regardless of whether they
   * also stream. An absent feature on a model reads as unsupported.
   */
  byFeatures(required: Partial<ModelFeatures>): readonly Model[] {
    return this.list().filter((m) => supportsAll(m.info.supports, required));
  }
}

/** Does `have` satisfy every feature demanded (`true`) in `want`? */
export function supportsAll(
  have: ModelFeatures,
  want: Partial<ModelFeatures>,
): boolean {
  for (const key of Object.keys(want) as (keyof ModelFeatures)[]) {
    if (want[key] === true && have[key] !== true) return false;
  }
  return true;
}
