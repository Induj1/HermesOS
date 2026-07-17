/**
 * Candidate selection — a pure function from a registry and criteria to an
 * ordered list of models to try.
 *
 * Pulling selection out of the router keeps the interesting policy testable
 * without invoking a model: given these registered models and this request, *in
 * what order* should the router try them? The router then just walks that list
 * with fallback. Order matters — it is the difference between "prefer the cheap
 * local model, fall back to the API" and the reverse.
 */

import type { Model, ModelFeatures } from '@hermes/model';
import { supportsAll, type ModelRegistry } from './registry.js';

export interface RouteCriteria {
  /**
   * An explicit preference order by model name. Only these models are considered,
   * in this order — the caller has decided the fallback chain. Names that are not
   * registered (or fail the other filters) are skipped, not an error.
   */
  readonly models?: readonly string[];
  /** Capabilities the chosen model must have (e.g. `{ tools: true }`). */
  readonly features?: Partial<ModelFeatures>;
  /** Restrict to one provider. */
  readonly provider?: string;
}

/**
 * The ordered candidates for a request.
 *
 * When `criteria.models` is given, it *is* the order (filtered by features and
 * provider). Otherwise every registered model that passes the filters is
 * returned in registration order — so a deployment expresses its default
 * preference simply by the order it registers models.
 */
export function selectCandidates(
  registry: ModelRegistry,
  criteria: RouteCriteria = {},
): readonly Model[] {
  const passes = (model: Model): boolean =>
    (criteria.provider === undefined || model.info.provider === criteria.provider) &&
    (criteria.features === undefined ||
      supportsAll(model.info.supports, criteria.features));

  if (criteria.models !== undefined) {
    const candidates: Model[] = [];
    for (const name of criteria.models) {
      const model = registry.get(name);
      if (model !== undefined && passes(model)) candidates.push(model);
    }
    return candidates;
  }

  return registry.list().filter(passes);
}
