# @hermes/loadtest

A deterministic in-process load harness — drive an operation at a bounded
concurrency and measure throughput and latency percentiles.

- **Design record:** [RFC-0035](../../docs/rfcs/RFC-0035-loadtest.md).
- **Depends on:** `@hermes/kernel` (the `Clock`), `@hermes/metrics` (optional
  histogram).
- **Milestone:** Production #39.

## Usage

```ts
import { systemClock } from '@hermes/kernel';
import { formatReport, runLoad } from '@hermes/loadtest';

// Drive the REST app at concurrency 50 for 1000 requests:
const report = await runLoad({
  count: 1000,
  concurrency: 50,
  clock: systemClock,
  operation: async () => {
    const res = await app.handle({
      method: 'GET',
      url: '/health',
      headers: {},
    });
    if (res.status >= 500) throw new Error('server error'); // counts as failed
  },
});

console.log(formatReport(report));
// requests:   1000 (1000 ok, 0 failed)
// wall:       …ms
// throughput: …/s
// latency:    min … · p50 … · p90 … · p99 … · max … (ms)
```

## Notes

- **Deterministic.** `runLoad` is a pure function of
  `(count, concurrency, clock, operation)`. Under a `TestClock` whose
  `operation` advances it, latencies and throughput are exact; under
  `systemClock` the same code measures a real target.
- **Percentiles, not just averages.** `summarize` reports p50/p90/p99 + min/max/
  mean — the tail is what hurts under load.
- **Metrics.** Pass a `@hermes/metrics` `Histogram` to observe each latency into
  the same instrument a live service exposes.
- **A driver, not a target.** You supply the `operation`; wire it to the REST
  `Application` or the `Worker` through their ports.
