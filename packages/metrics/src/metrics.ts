/**
 * Metrics — counters, gauges, and histograms, with labels. Zero dependencies.
 *
 * The three instrument types cover what an operator asks of a running system:
 *
 * - **Counter** — a value that only goes up (requests served, errors, tokens
 *   billed). Its *rate* is the interesting thing, computed by the scraper.
 * - **Gauge** — a value that goes up and down (in-flight requests, queue depth,
 *   memory). A point-in-time reading.
 * - **Histogram** — a distribution (request latency, response size) into fixed
 *   buckets, so percentiles are computable without keeping every sample.
 *
 * All of them are labelled: one `http_requests_total` metric with `{method, status}`
 * labels is many time series, which is how a dashboard slices by route or status.
 * A metric declares its label *names* up front, and each observation supplies the
 * *values* — the pairing that keeps a typo from silently creating a new series.
 *
 * The registry snapshots to a plain structure and to Prometheus text; it holds no
 * clock and does no I/O, so it is a pure accumulator a caller reads on a `/metrics`
 * scrape.
 */

export type Labels = Readonly<Record<string, string>>;

export type MetricType = 'counter' | 'gauge' | 'histogram';

/** One labelled data point in a snapshot. */
export interface Sample {
  readonly labels: Labels;
  readonly value: number;
}

/** A histogram's per-series distribution. */
export interface HistogramSample {
  readonly labels: Labels;
  /** Cumulative count per upper bound (`le`), plus `+Inf`. */
  readonly buckets: readonly { readonly le: number; readonly count: number }[];
  readonly count: number;
  readonly sum: number;
}

export interface MetricSnapshot {
  readonly name: string;
  readonly help: string;
  readonly type: MetricType;
  /** Points for counters/gauges; empty for a histogram. */
  readonly samples: readonly Sample[];
  /** Distributions for a histogram; empty for counters/gauges. */
  readonly histograms: readonly HistogramSample[];
}

/** Shared label bookkeeping: a stable key per label-value combination. */
abstract class LabelledMetric {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];

  constructor(name: string, help: string, labelNames: readonly string[]) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
  }

  /** A canonical key for a label set — sorted, so `{a,b}` and `{b,a}` are one series. */
  protected key(labels: Labels): string {
    for (const name of Object.keys(labels)) {
      if (!this.labelNames.includes(name)) {
        throw new Error(`metric "${this.name}" has no label "${name}"`);
      }
    }
    return this.labelNames.map((n) => `${n}=${labels[n] ?? ''}`).join(',');
  }

  protected labelsOf(labels: Labels): Labels {
    const out: Record<string, string> = {};
    for (const n of this.labelNames) out[n] = labels[n] ?? '';
    return out;
  }
}

export class Counter extends LabelledMetric {
  readonly #values = new Map<string, { labels: Labels; value: number }>();

  /** Add to the counter (default 1). Throws on a negative delta — counters only rise. */
  inc(labels: Labels = {}, by = 1): void {
    if (by < 0) throw new Error(`counter "${this.name}" cannot decrease`);
    const key = this.key(labels);
    const entry = this.#values.get(key) ?? { labels: this.labelsOf(labels), value: 0 };
    entry.value += by;
    this.#values.set(key, entry);
  }

  /** The current value for a label set. */
  get(labels: Labels = {}): number {
    return this.#values.get(this.key(labels))?.value ?? 0;
  }

  samples(): readonly Sample[] {
    return [...this.#values.values()];
  }
}

export class Gauge extends LabelledMetric {
  readonly #values = new Map<string, { labels: Labels; value: number }>();

  set(value: number, labels: Labels = {}): void {
    this.#values.set(this.key(labels), { labels: this.labelsOf(labels), value });
  }

  inc(by = 1, labels: Labels = {}): void {
    this.set(this.get(labels) + by, labels);
  }

  dec(by = 1, labels: Labels = {}): void {
    this.set(this.get(labels) - by, labels);
  }

  get(labels: Labels = {}): number {
    return this.#values.get(this.key(labels))?.value ?? 0;
  }

  samples(): readonly Sample[] {
    return [...this.#values.values()];
  }
}

interface Series {
  readonly labels: Labels;
  readonly bucketCounts: number[];
  count: number;
  sum: number;
}

export class Histogram extends LabelledMetric {
  readonly #buckets: readonly number[];
  readonly #series = new Map<string, Series>();

  constructor(
    name: string,
    help: string,
    buckets: readonly number[],
    labelNames: readonly string[],
  ) {
    super(name, help, labelNames);
    // Sorted ascending; +Inf is implicit (the total count).
    this.#buckets = [...buckets].sort((a, b) => a - b);
  }

  /** Record an observation into the buckets it falls under. */
  observe(value: number, labels: Labels = {}): void {
    const key = this.key(labels);
    const series = this.#series.get(key) ?? {
      labels: this.labelsOf(labels),
      bucketCounts: this.#buckets.map(() => 0),
      count: 0,
      sum: 0,
    };
    series.count += 1;
    series.sum += value;
    this.#buckets.forEach((bound, i) => {
      if (value <= bound) series.bucketCounts[i] = (series.bucketCounts[i] ?? 0) + 1;
    });
    this.#series.set(key, series);
  }

  histograms(): readonly HistogramSample[] {
    return [...this.#series.values()].map((s) => ({
      labels: s.labels,
      buckets: this.#buckets.map((le, i) => ({ le, count: s.bucketCounts[i] ?? 0 })),
      count: s.count,
      sum: s.sum,
    }));
  }
}
