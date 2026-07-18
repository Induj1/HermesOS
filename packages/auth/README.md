# @hermes/auth

Authentication — a credential goes in, a `Principal` comes out; nothing
downstream touches the raw credential again.

- **Design record:** [RFC-0029](../../docs/rfcs/RFC-0029-auth.md).
- **Depends on:** nothing.

## Usage

```ts
import {
  ApiKeyAuthenticator,
  authenticateHeaders,
  principal,
} from '@hermes/auth';

const authenticator = new ApiKeyAuthenticator({
  'sk-admin': principal('admin', {
    kind: 'service',
    scopes: ['missions:write'],
  }),
  'sk-reader': principal('reader', { scopes: ['missions:read'] }),
});

// In a REST middleware:
const result = await authenticateHeaders(authenticator, request.headers);
if (!result.ok) return unauthorized(); // one uniform 401
context.state.principal = result.principal; // hand off to authorization (#27)
```

## Concepts

- **Principal.** The safe-to-log result of authentication: `id`, `kind`
  (`user`/`service`/`anonymous`), `scopes`, `attributes`. Never the credential.
- **Authenticators.** `ApiKeyAuthenticator` (opaque key → principal, constant-
  time compare), `ChainAuthenticator` (first success wins). `Authenticator` is
  the port for future signed-token/OAuth adapters.
- **Constant-time & uniform failure.** Keys compare without early exit; every
  failure is a generic `{ ok: false, reason }` → one `401`.
- **HTTP boundary.** `authenticateHeaders` / `extractBearer` read a plain header
  record, so there's no REST dependency.
