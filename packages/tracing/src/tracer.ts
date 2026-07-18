/**
 * The tracer — starts spans, threading trace identity from parent to child.
 *
 * A root span (no parent) gets a fresh trace id and the tracer's default sampled
 * flag; a child span inherits its parent's trace id and sampled flag and records
 * the parent's span id, so a whole request forms one connected trace. Timing and
 * ids are injected (`Clock`, `IdGenerator`), so a trace is fully deterministic
 * under test.
 */

import type { Clock } from '@hermes/kernel';
import type { SpanContext } from './context.js';
import type { IdGenerator } from './ids.js';
import { Span, type Attributes, type SpanExporter } from './span.js';

export interface TracerOptions {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly exporter: SpanExporter;
  /** The sampled flag for root spans (default `true`). */
  readonly sampled?: boolean;
}

export interface StartSpanOptions {
  /** The parent context — from an in-process span or a parsed `traceparent`. */
  readonly parent?: SpanContext;
  /** Attributes to set at creation. */
  readonly attributes?: Attributes;
  /** Override the start time (default: the clock's current time). */
  readonly startMs?: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Tracer {
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #exporter: SpanExporter;
  readonly #sampled: boolean;

  constructor(options: TracerOptions) {
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#exporter = options.exporter;
    this.#sampled = options.sampled ?? true;
  }

  /** Start a span. With `options.parent`, it is a child of that context. */
  startSpan(name: string, options: StartSpanOptions = {}): Span {
    const parent = options.parent;
    const context: SpanContext =
      parent === undefined
        ? {
            traceId: this.#ids.traceId(),
            spanId: this.#ids.spanId(),
            sampled: this.#sampled,
          }
        : {
            traceId: parent.traceId,
            spanId: this.#ids.spanId(),
            sampled: parent.sampled,
          };

    return new Span({
      name,
      context,
      parentSpanId: parent?.spanId,
      startMs: options.startMs ?? this.#clock.now(),
      clock: this.#clock,
      exporter: this.#exporter,
      attributes: options.attributes ?? {},
    });
  }

  /**
   * Run `fn` inside a span, ending it automatically. A thrown error is recorded
   * as `error` status (with its message) and re-thrown; a clean return leaves
   * the status `unset` unless `fn` set it. This is the ergonomic default — the
   * span cannot be left un-ended.
   */
  async withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T> | T,
    options: StartSpanOptions = {},
  ): Promise<T> {
    const span = this.startSpan(name, options);
    try {
      return await fn(span);
    } catch (error) {
      span.setStatus('error', messageOf(error));
      throw error;
    } finally {
      span.end();
    }
  }
}
