/**
 * @hermes/auth — Authentication: credentials in, a principal out.
 *
 * ```ts
 * const authenticator = new ApiKeyAuthenticator({
 *   'sk-admin': principal('admin', { kind: 'service', scopes: ['missions:write'] }),
 * });
 *
 * const result = await authenticateHeaders(authenticator, request.headers);
 * if (!result.ok) return unauthorized();
 * ctx.principal = result.principal; // hand off to authorization (#27)
 * ```
 *
 * A `Principal` is the safe-to-log *result* of authentication (id, kind, scopes,
 * attributes) — never the credential. API keys are compared in constant time.
 */

export {
  anonymous,
  isAuthenticated,
  principal,
  type Principal,
  type PrincipalKind,
  type PrincipalOptions,
} from './principal.js';

export {
  ApiKeyAuthenticator,
  ChainAuthenticator,
  constantTimeEqual,
  type AuthResult,
  type Authenticator,
} from './authenticator.js';

export { authenticateHeaders, extractBearer, type Headers } from './http.js';
