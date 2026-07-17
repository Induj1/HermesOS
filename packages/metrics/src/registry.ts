/**
 * The metrics registry — create instruments once, snapshot them for a scrape.
 *
 * A registry owns the named instruments a subsystem publishes. `counter`/`gauge`/
 * `histogram` are get-or-create: calling with the same name returns the same
 * instrument (so two modules incrementing `http_requests_total` share one series
 * set), and a name reused with a *different type* throws — that is a bug, not a
 * silent second metric. `snapshot` and `toPrometheus` read the whole set; the
 * registry itself keeps no clock and does no I/O.
 */

import {
  Counter,
  Gauge,
  Histogram,
  type MetricSnapshot,
  type MetricType,
} from './metrics.js';

interface Entry {
  readonly type: MetricType;
  readonly metric: Counter | Gauge | Histogram;
}

export class MetricsRegistry {
  readonly #entries = new Map<string, Entry>();

  /** Get or create a counter. */
  counter(name: string, help = '', labelNames: readonly string[] = []): Counter {
    return this.#getOrCreate(
      name,
      'counter',
      () => new Counter(name, help, labelNames),
    ) as Counter;
  }

  /** Get or create a gauge. */
  gauge(name: string, help = '', labelNames: readonly string[] = []): Gauge {
    return this.#getOrCreate(
      name,
      'gauge',
      () => new Gauge(name, help, labelNames),
    ) as Gauge;
  }

  /** Get or create a histogram with the given upper-bound buckets. */
  histogram(
    name: string,
    buckets: readonly number[],
    help = '',
    labelNames: readonly string[] = [],
  ): Histogram {
    return this.#getOrCreate(
      name,
      'histogram',
      () => new Histogram(name, help, buckets, labelNames),
    ) as Histogram;
  }

  /** Every metric, as a plain structure. */
  snapshot(): readonly MetricSnapshot[] {
    return [...this.#entries.values()].map(({ type, metric }) => {
      const base = { name: metric.name, help: metric.help, type };
      return metric instanceof Histogram
        ? { ...base, samples: [], histograms: metric.histograms() }
        : { ...base, samples: metric.samples(), histograms: [] };
    });
  }

  /** The Prometheus text exposition format, for a `/metrics` endpoint. */
  toPrometheus(): string {
    const lines: string[] = [];
    for (const snapshot of this.snapshot()) {
      if (snapshot.help !== '') lines.push(`# HELP ${snapshot.name} ${snapshot.help}`);
      lines.push(`# TYPE ${snapshot.name} ${snapshot.type}`);
      if (snapshot.type === 'histogram') {
        for (const h of snapshot.histograms) {
          for (const bucket of h.buckets) {
            lines.push(
              `${snapshot.name}_bucket${labelStr(h.labels, { le: String(bucket.le) })} ${String(bucket.count)}`,
            );
          }
          lines.push(
            `${snapshot.name}_bucket${labelStr(h.labels, { le: '+Inf' })} ${String(h.count)}`,
          );
          lines.push(`${snapshot.name}_sum${labelStr(h.labels)} ${String(h.sum)}`);
          lines.push(`${snapshot.name}_count${labelStr(h.labels)} ${String(h.count)}`);
        }
      } else {
        for (const sample of snapshot.samples) {
          lines.push(
            `${snapshot.name}${labelStr(sample.labels)} ${String(sample.value)}`,
          );
        }
      }
    }
    return lines.join('\n') + (lines.length > 0 ? '\n' : '');
  }

  #getOrCreate(
    name: string,
    type: MetricType,
    create: () => Counter | Gauge | Histogram,
  ): Counter | Gauge | Histogram {
    const existing = this.#entries.get(name);
    if (existing !== undefined) {
      if (existing.type !== type) {
        throw new Error(
          `metric "${name}" already registered as a ${existing.type}, not a ${type}`,
        );
      }
      return existing.metric;
    }
    const metric = create();
    this.#entries.set(name, { type, metric });
    return metric;
  }
}

/** Render a label set (plus optional extras) as `{a="1",b="2"}`, or empty. */
function labelStr(
  labels: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string>> = {},
): string {
  const entries = Object.entries({ ...labels, ...extra });
  if (entries.length === 0) return '';
  const pairs = entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return `{${pairs.join(',')}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}
