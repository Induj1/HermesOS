/**
 * @hermes/provider-http — the HTTP plumbing every model provider shares.
 *
 * See `http.ts` for the design. A provider client calls {@link postJson} with its
 * own headers and a {@link ClassifyFn} built from {@link statusClassifier} — the
 * transport mapping and the retryable-or-not status classification are uniform
 * across providers, so a rate limit and an invalid request are told apart the
 * same way everywhere (which is what the model router's fallback relies on).
 */

export {
  postJson,
  statusClassifier,
  retryAfterMs,
  errorObject,
  messageOf,
  codeOf,
  safeJson,
} from './http.js';
export type { ClassifyFn, PostJsonParams, StatusClassifierOptions } from './http.js';
