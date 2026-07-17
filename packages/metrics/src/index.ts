/**
 * @hermes/metrics — zero-dependency counters, gauges, histograms, and a Prometheus
 * text formatter.
 *
 * A {@link MetricsRegistry} owns the named instruments a subsystem publishes;
 * `snapshot()` reads them as plain data and `toPrometheus()` renders the standard
 * exposition format for a `/metrics` endpoint. It holds no clock and does no I/O —
 * a pure accumulator, so tests assert exact values and a scrape is a plain read.
 *
 * ```ts
 * import { MetricsRegistry } from '@hermes/metrics';
 *
 * const metrics = new MetricsRegistry();
 * const requests = metrics.counter('http_requests_total', 'HTTP requests', ['method', 'status']);
 * const latency = metrics.histogram('http_latency_seconds', [0.01, 0.1, 1, 10], 'latency', ['route']);
 *
 * requests.inc({ method: 'GET', status: '200' });
 * latency.observe(0.042, { route: '/missions' });
 *
 * response.body = metrics.toPrometheus(); // for GET /metrics
 * ```
 *
 * See `docs/rfcs/RFC-0023-metrics.md` for the design.
 */

export { MetricsRegistry } from './registry.js';
export { Counter, Gauge, Histogram } from './metrics.js';
export type {
  Labels,
  MetricType,
  Sample,
  HistogramSample,
  MetricSnapshot,
} from './metrics.js';
