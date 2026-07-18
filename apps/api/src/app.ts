/**
 * The application wiring — the composition root as a pure function.
 *
 * `buildApp` takes its dependencies (a logger, a health monitor, a metrics
 * registry, a clock) and returns a REST `Application` with the operational
 * endpoints every production service needs. It touches no socket and reads no
 * environment, so the whole routing/observability surface is tested with
 * `app.handle(request)` — `main.ts` is the only piece that binds a port.
 *
 * Endpoints:
 * - `GET /`        — service identity (name + version).
 * - `GET /livez`   — liveness (is the process wedged?). 200/503.
 * - `GET /readyz`  — readiness (are dependencies reachable?). 200/503.
 * - `GET /metrics` — Prometheus exposition of the registry.
 */

import type { HealthMonitor } from '@hermes/health';
import { httpStatusFor } from '@hermes/health';
import type { Clock, Logger } from '@hermes/kernel';
import type { MetricsRegistry } from '@hermes/metrics';
import { Application, HttpError, json, text, type Middleware } from '@hermes/rest';

export interface AppDeps {
  readonly logger: Logger;
  readonly health: HealthMonitor;
  readonly metrics: MetricsRegistry;
  readonly clock: Clock;
  readonly serviceName: string;
  readonly version: string;
}

export function buildApp(deps: AppDeps): Application {
  const requests = deps.metrics.counter('http_requests_total', 'HTTP requests', [
    'method',
    'status',
  ]);
  const latency = deps.metrics.histogram(
    'http_request_duration_ms',
    [1, 5, 10, 50, 100, 500, 1000],
    'Request duration in milliseconds',
    ['method'],
  );

  const app = new Application();
  app.use(observability(deps, requests, latency));

  app.get('/', () => json(200, { name: deps.serviceName, version: deps.version }));

  app.get('/livez', async () => {
    const report = await deps.health.report({ kind: 'liveness' });
    return json(httpStatusFor(report.status), report);
  });

  app.get('/readyz', async () => {
    const report = await deps.health.report({ kind: 'readiness' });
    return json(httpStatusFor(report.status), report);
  });

  app.get('/metrics', () => text(200, deps.metrics.toPrometheus()));

  return app;
}

/**
 * The HTTP status an error will resolve to — an `HttpError`'s own status, or
 * `500` for an unexpected throw. Kept here (and exported) so the observability
 * middleware records the *same* status the error boundary will send, and both
 * branches are unit-testable without a 500-producing route.
 */
export function errorStatus(error: unknown): number {
  return error instanceof HttpError ? error.status : 500;
}

/**
 * Count every request, time it, and log it — including the ones that throw. The
 * REST error boundary sits outside the middleware chain, so a 404/405/500 would
 * otherwise go uncounted; the catch records it and re-throws for the boundary to
 * format.
 */
function observability(
  deps: AppDeps,
  requests: ReturnType<MetricsRegistry['counter']>,
  latency: ReturnType<MetricsRegistry['histogram']>,
): Middleware {
  const record = (
    request: Parameters<Middleware>[0],
    context: Parameters<Middleware>[1],
    status: number,
    start: number,
  ): void => {
    const durationMs = deps.clock.now() - start;
    requests.inc({ method: request.method, status: String(status) });
    latency.observe(durationMs, { method: request.method });
    deps.logger.info('request', {
      requestId: context.requestId,
      method: request.method,
      path: request.path,
      status,
      durationMs,
    });
  };

  return async (request, context, next) => {
    const start = deps.clock.now();
    try {
      const response = await next();
      record(request, context, response.status, start);
      return response;
    } catch (error) {
      record(request, context, errorStatus(error), start);
      throw error;
    }
  };
}
