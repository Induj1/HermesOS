/**
 * @hermes/api — the HermesOS HTTP API service.
 *
 * `buildApp(deps)` is the composition root as a pure function (operational
 * endpoints: `/`, `/livez`, `/readyz`, `/metrics`); `main()` (in `main.ts`, the
 * `hermes-api` bin) wires it to config, real dependencies, and a socket.
 */

export { buildApp, type AppDeps } from './app.js';
export { API_VERSION, apiSchema, type ApiConfig } from './config.js';
