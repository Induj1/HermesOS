/**
 * The composition root — operational endpoints and the observability middleware,
 * exercised through app.handle() with no socket.
 */

import { HealthMonitor, check, healthy, unhealthy } from '@hermes/health';
import { TestClock } from '@hermes/kernel';
import { StructuredLogger, MemorySink } from '@hermes/logger';
import { MetricsRegistry } from '@hermes/metrics';
import { HttpError, type HttpRequest } from '@hermes/rest';
import { describe, expect, it } from 'vitest';
import { buildApp, errorStatus, type AppDeps } from '../src/app.js';

function get(path: string): HttpRequest {
  return { method: 'GET', path, query: {}, headers: {}, body: undefined, params: {} };
}

const parse = (body: string | undefined): Record<string, unknown> =>
  JSON.parse(body ?? '{}') as Record<string, unknown>;

function deps(overrides: Partial<AppDeps> = {}): AppDeps {
  const clock = new TestClock();
  return {
    logger: new StructuredLogger({ sink: new MemorySink(), clock }),
    health: new HealthMonitor([check('live', () => healthy(), 'liveness')], { clock }),
    metrics: new MetricsRegistry(),
    clock,
    serviceName: 'test-api',
    version: '9.9.9',
    ...overrides,
  };
}

describe('errorStatus', () => {
  it('uses an HttpError status and defaults others to 500', () => {
    expect(errorStatus(new HttpError(404, 'nope'))).toBe(404);
    expect(errorStatus(new Error('boom'))).toBe(500);
  });
});

describe('GET /', () => {
  it('returns the service identity', async () => {
    const app = buildApp(deps());
    const res = await app.handle(get('/'));
    expect(res.status).toBe(200);
    expect(parse(res.body)).toEqual({ name: 'test-api', version: '9.9.9' });
  });
});

describe('GET /livez', () => {
  it('is 200 when liveness checks pass', async () => {
    const res = await buildApp(deps()).handle(get('/livez'));
    expect(res.status).toBe(200);
    expect(parse(res.body)['status']).toBe('healthy');
  });
});

describe('GET /readyz', () => {
  it('is 503 when a readiness check is unhealthy', async () => {
    const clock = new TestClock();
    const health = new HealthMonitor(
      [
        check('live', () => healthy(), 'liveness'),
        check('db', () => unhealthy('unreachable'), 'readiness'),
      ],
      { clock },
    );
    const res = await buildApp(deps({ health, clock })).handle(get('/readyz'));
    expect(res.status).toBe(503);
    expect(parse(res.body)['status']).toBe('unhealthy');
  });

  it('is 200 when there are no readiness checks', async () => {
    const res = await buildApp(deps()).handle(get('/readyz'));
    expect(res.status).toBe(200);
  });
});

describe('GET /metrics', () => {
  it('exposes the Prometheus registry after traffic', async () => {
    const app = buildApp(deps());
    await app.handle(get('/'));
    const res = await app.handle(get('/metrics'));
    expect(res.status).toBe(200);
    expect(res.body).toContain('http_requests_total');
    expect(res.body).toContain('http_request_duration_ms_bucket');
  });
});

describe('observability middleware', () => {
  it('counts requests by method and status and logs each one', async () => {
    const clock = new TestClock();
    const sink = new MemorySink();
    const logger = new StructuredLogger({ sink, clock, level: 'debug' });
    const metrics = new MetricsRegistry();
    const app = buildApp(deps({ clock, logger, metrics }));

    await app.handle(get('/'));
    await app.handle(get('/nope')); // 404

    const counter = metrics.counter('http_requests_total', '', ['method', 'status']);
    expect(counter.get({ method: 'GET', status: '200' })).toBe(1);
    expect(counter.get({ method: 'GET', status: '404' })).toBe(1);
    expect(sink.records).toHaveLength(2);
    expect(sink.records[0]?.fields['path']).toBe('/');
  });

  it('records request duration from the clock', async () => {
    const clock = new TestClock();
    const metrics = new MetricsRegistry();
    // A handler-free path still passes through the middleware; advance the clock
    // inside a liveness check so the measured duration is non-zero.
    const health = new HealthMonitor(
      [
        check(
          'slow',
          async () => {
            await clock.advance(50);
            return healthy();
          },
          'liveness',
        ),
      ],
      { clock },
    );
    const app = buildApp(deps({ clock, metrics, health }));
    await app.handle(get('/livez'));
    const histogram = metrics.histogram('http_request_duration_ms', [1, 100], '', [
      'method',
    ]);
    expect(histogram.histograms()[0]?.count).toBe(1);
  });
});
