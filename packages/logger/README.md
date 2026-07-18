# @hermes/logger

Structured, leveled logging — JSON records with secret-safe fields and trace
correlation. Implements the kernel's `Logger` contract.

- **Design record:** [RFC-0028](../../docs/rfcs/RFC-0028-observability.md).
- **Depends on:** `@hermes/kernel` (`Logger`, `LogFields`, `Clock`).

## Usage

```ts
import { systemClock } from '@hermes/kernel';
import { StructuredLogger, consoleSink, withTrace } from '@hermes/logger';

const logger = new StructuredLogger({
  sink: consoleSink(),
  clock: systemClock,
  level: 'info',
  fields: { service: 'api' },
});

logger.info('server started', { port: 3000 });
// {"time":...,"level":"info","msg":"server started","service":"api","port":3000}

// Per-request context, correlated with a trace:
const reqLog = withTrace(logger.child({ requestId }), span.context());
reqLog.debug('handling', { route: '/missions' }); // dropped at level=info
reqLog.error('db failed', { apiKey: secret }); // apiKey → "[redacted]"
```

## Concepts

- **Levels.** `debug < info < warn < error`. Records below the configured level
  are dropped before the sink.
- **Fields & `child`.** `logger.child(fields)` binds context onto every
  downstream record; per-call fields merge over bound fields (later wins).
- **Sinks.** `MemorySink` (tests), `jsonLinesSink(write)` (inject a writer),
  `consoleSink()` (stdout for debug/info, stderr for warn/error).
- **Secret-safe.** A `@hermes/secrets` `Secret` in a field serializes as
  `[redacted]` — no allowlist needed.
- **Trace correlation.** `withTrace(logger, spanContext)` stamps `traceId`/
  `spanId` onto every record, so logs and spans line up in a backend.
- **Deterministic.** Time and output are injected; tests use a `TestClock` and a
  `MemorySink`.
