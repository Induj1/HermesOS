/**
 * @hermes/logger — Structured, leveled logging with trace correlation.
 *
 * Implements the kernel's `Logger` contract, so anything that takes a `Logger`
 * takes this. Records carry a timestamp from an injected `Clock` and go to an
 * injected `LogSink`, so the logger is deterministic and does no I/O itself:
 *
 * ```ts
 * const logger = new StructuredLogger({ sink: consoleSink(), clock: systemClock, level: 'info' });
 * logger.info('server started', { port: 3000 });
 *
 * // Per-request context, correlated with a trace:
 * const reqLog = withTrace(logger.child({ requestId }), span.context());
 * reqLog.debug('handling', { route: '/missions' }); // dropped at level=info
 * reqLog.error('db failed', { apiKey: secret }); // apiKey → "[redacted]"
 * ```
 *
 * A `Secret` in a field serializes as `[redacted]`, so context can be logged
 * without leaking a key.
 */

export {
  StructuredLogger,
  isLevelEnabled,
  type LogLevel,
  type LogRecord,
  type LogSink,
  type LoggerOptions,
} from './logger.js';

export { MemorySink, formatJsonLine, jsonLinesSink } from './sink.js';

export { traceFields, withTrace } from './trace.js';

export { consoleSink } from './node.js';
