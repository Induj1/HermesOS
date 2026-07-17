# @hermes/provider-http

The HTTP plumbing every Hermes model provider shares — JSON POST, transport
mapping, and a uniform status → `ModelError` classifier.

- **Design record:** [RFC-0018](../../docs/rfcs/RFC-0018-provider-http.md).
- **Depends on:** `@hermes/model`, `@hermes/tools-http`.

## Why

A provider is two vendor-specific translations plus a lot of identical HTTP
work. That work — and especially the "is this failure retryable" classification
the model router's fallback depends on — must be **uniform** across providers,
so it lives here once instead of being re-derived (and diverging) in each
client.

It is composition, not inheritance: a client _calls_ `postJson` with its own
headers and a `ClassifyFn`, keeping its own public shape.

## Usage (inside a provider client)

```ts
import { postJson, statusClassifier, codeOf } from '@hermes/provider-http';
import { ContextTooLongError } from '@hermes/model';

const classify = statusClassifier('openai', {
  // vendor-specific: OpenAI signals context overflow with an error code
  override: (status, _headers, body) =>
    (status === 400 || status === 422) &&
    codeOf(body) === 'context_length_exceeded'
      ? new ContextTooLongError('openai')
      : undefined,
});

const data = await postJson<Response>({
  http,
  url,
  headers: { authorization: `Bearer ${key}` },
  body,
  provider: 'openai',
  classify,
  signal,
});
```

## What it provides

- **`postJson`** — POST JSON; transport `TIMEOUT` → `ModelTimeout`, other faults
  → `ModelUnavailable` (both retryable); non-2xx → your `classify`.
- **`statusClassifier(provider, { override? })`** — the standard mapping
  (`401/403` auth · `429` rate limit + `retry-after` · `404`/`5xx` unavailable ·
  `400/422` invalid · else generic), with a vendor `override` that runs first.
- **`safeJson` · `retryAfterMs` · `messageOf` · `codeOf` · `errorObject`** —
  parse helpers.

Nothing here names a vendor.
