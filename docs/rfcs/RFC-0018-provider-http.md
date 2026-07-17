# RFC-0018: Shared Provider HTTP

| Field         | Value                                              |
| ------------- | -------------------------------------------------- |
| Status        | Implemented                                        |
| Date          | 2026-07-18                                         |
| Scope         | `packages/provider-http` (`@hermes/provider-http`) |
| Depends on    | `@hermes/model`, `@hermes/tools-http`              |
| Supersedes    | —                                                  |
| Superseded by | —                                                  |

Design record for the shared HTTP plumbing extracted from the model providers.

Covered by 22 tests in `packages/provider-http/tests`.

---

## 1. Why it exists (rule of three)

The OpenAI and Anthropic clients had grown near-identical copies of the same
code: POST a JSON body, map a transport failure to a `ModelError`, and classify
a non-2xx status into the retryable-or-not error the router's fallback reads.
With `safeJson`, `retryAfterMs`, `messageOf`, and the status mapping about to be
copied a _third_ time for Gemini, the duplication reached the rule of three and
earned a home.

The extracted piece is not just DRY convenience — the status classification
**must** be uniform. If each provider classified `429` vs `400` its own way, the
router's fallback would behave differently per provider, which is exactly the
inconsistency the `ModelError.retryable` contract exists to prevent. One
classifier, one behaviour.

## 2. Composition, not inheritance

A provider client does not _extend_ a base class; it _calls_ {@link postJson}
with its own headers and a {@link ClassifyFn}. This keeps each client's public
shape (`OpenAIClient`, `AnthropicClient` are unchanged to their callers) and
avoids a base class that would have to know every vendor's header scheme. The
per-vendor differences are expressed as data — the headers passed in, and a
`statusClassifier` `override` for the handful of vendor-specific cases (OpenAI's
`context_length_exceeded`, Anthropic's too-long-prompt message).

## 3. What it provides

- **`postJson`** — POST JSON, map a transport `HttpError` (`TIMEOUT` →
  `ModelTimeout`, else `ModelUnavailable`, both retryable) or re-throw a
  non-Error, and hand a non-2xx to the caller's `classify`.
- **`statusClassifier(provider, { override? })`** — the standard mapping
  (`401/403` auth, `429` rate limit + `retry-after`, `404`/`5xx`
  unavailable-retryable, `400/422` invalid, else generic), with a vendor
  `override` that runs first.
- **`safeJson`, `retryAfterMs`, `messageOf`, `codeOf`, `errorObject`** — the
  small parse helpers all clients need.

Nothing here names a vendor; the package depends only on the contracts and the
HTTP port.

## 4. Testing

100% line/branch coverage: the POST happy path and header merge, all three
transport outcomes, every status in the standard mapping (incl. `529`), the
`retry-after` and message extraction, the override pre-empting and falling
through, and each parse helper across its shapes.

## 5. Impact

The OpenAI and Anthropic clients shrank from ~130 lines each to ~70, with the
transport and classification now shared and tested once. Both providers' suites
still pass unchanged (a caller cannot tell the internals moved), and the Gemini
provider (#19) is built on this base rather than copying it a third time.
