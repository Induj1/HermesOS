/**
 * Spans — a timed unit of work in a trace, and the exporter that receives them.
 *
 * A `Span` is recorded through while the work runs (`setAttribute`, `addEvent`,
 * `setStatus`) and `end()`ed once, at which point it is frozen into an immutable
 * `FinishedSpan` and handed to the `SpanExporter`. Recording after `end()` is a
 * no-op rather than an error, so a late callback cannot corrupt a closed span or
 * double-export it — the common tracing bug.
 */

import type { Clock } from '@hermes/kernel';
import type { SpanContext } from './context.js';

export type AttributeValue = string | number | boolean;
export type Attributes = Readonly<Record<string, AttributeValue>>;

export type SpanStatus = 'unset' | 'ok' | 'error';

/** A point-in-time event recorded on a span. */
export interface SpanEvent {
  readonly name: string;
  readonly timeMs: number;
  readonly attributes: Attributes;
}

/** An ended span, immutable, as an exporter and backend see it. */
export interface FinishedSpan {
  readonly name: string;
  readonly context: SpanContext;
  readonly parentSpanId: string | undefined;
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
  readonly attributes: Attributes;
  readonly events: readonly SpanEvent[];
  readonly status: SpanStatus;
  readonly statusMessage: string | undefined;
}

/** Receives finished spans — the seam to a backend (OTLP, a log, a test buffer). */
export interface SpanExporter {
  export(span: FinishedSpan): void;
}

/** An exporter that keeps finished spans in memory — the test double. */
export class InMemorySpanExporter implements SpanExporter {
  readonly #spans: FinishedSpan[] = [];

  export(span: FinishedSpan): void {
    this.#spans.push(span);
  }

  /** Every span exported so far, in end order. */
  get spans(): readonly FinishedSpan[] {
    return this.#spans;
  }

  /** Drop all recorded spans. */
  reset(): void {
    this.#spans.length = 0;
  }
}

interface SpanInit {
  readonly name: string;
  readonly context: SpanContext;
  readonly parentSpanId: string | undefined;
  readonly startMs: number;
  readonly clock: Clock;
  readonly exporter: SpanExporter;
  readonly attributes: Attributes;
}

export class Span {
  readonly #context: SpanContext;
  readonly #parentSpanId: string | undefined;
  readonly #startMs: number;
  readonly #clock: Clock;
  readonly #exporter: SpanExporter;
  readonly #attributes: Record<string, AttributeValue>;
  readonly #events: SpanEvent[] = [];
  #name: string;
  #status: SpanStatus = 'unset';
  #statusMessage: string | undefined;
  #ended = false;

  constructor(init: SpanInit) {
    this.#name = init.name;
    this.#context = init.context;
    this.#parentSpanId = init.parentSpanId;
    this.#startMs = init.startMs;
    this.#clock = init.clock;
    this.#exporter = init.exporter;
    this.#attributes = { ...init.attributes };
  }

  /** This span's propagatable context. */
  context(): SpanContext {
    return this.#context;
  }

  /** Whether the span has been ended. */
  get ended(): boolean {
    return this.#ended;
  }

  /** Rename the span (e.g. once the route is resolved). No-op after `end()`. */
  setName(name: string): this {
    if (!this.#ended) this.#name = name;
    return this;
  }

  /** Set one attribute. No-op after `end()`. */
  setAttribute(key: string, value: AttributeValue): this {
    if (!this.#ended) this.#attributes[key] = value;
    return this;
  }

  /** Merge several attributes. No-op after `end()`. */
  setAttributes(attributes: Attributes): this {
    if (!this.#ended) Object.assign(this.#attributes, attributes);
    return this;
  }

  /** Record a timestamped event. No-op after `end()`. */
  addEvent(name: string, attributes: Attributes = {}): this {
    if (!this.#ended) {
      this.#events.push({
        name,
        timeMs: this.#clock.now(),
        attributes: { ...attributes },
      });
    }
    return this;
  }

  /** Set the terminal status. No-op after `end()`. */
  setStatus(status: SpanStatus, message?: string): this {
    if (!this.#ended) {
      this.#status = status;
      this.#statusMessage = message;
    }
    return this;
  }

  /**
   * End the span and export it. Idempotent: a second call does nothing, so a
   * span cannot be exported twice. `endMs` defaults to the clock's current time.
   */
  end(endMs?: number): void {
    if (this.#ended) return;
    this.#ended = true;
    const finishedAt = endMs ?? this.#clock.now();
    this.#exporter.export({
      name: this.#name,
      context: this.#context,
      parentSpanId: this.#parentSpanId,
      startMs: this.#startMs,
      endMs: finishedAt,
      durationMs: finishedAt - this.#startMs,
      attributes: { ...this.#attributes },
      events: [...this.#events],
      status: this.#status,
      statusMessage: this.#statusMessage,
    });
  }
}
