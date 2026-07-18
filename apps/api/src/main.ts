/**
 * The entrypoint — the one impure module: load config from the environment,
 * construct the real dependencies, and bind a socket. Everything decision-making
 * lives in `buildApp`; this wires it to the process and is exercised by running
 * the service (it is excluded from unit coverage for that reason).
 */

import { createServer } from 'node:http';
import { loadConfigFromEnv } from '@hermes/config';
import { HealthMonitor, check, healthy } from '@hermes/health';
import { systemClock } from '@hermes/kernel';
import { StructuredLogger, consoleSink } from '@hermes/logger';
import { MetricsRegistry } from '@hermes/metrics';
import { toNodeListener } from '@hermes/rest';
import { API_VERSION, apiSchema } from './config.js';
import { buildApp } from './app.js';

export function main(): void {
  const config = loadConfigFromEnv(apiSchema);

  const logger = new StructuredLogger({
    sink: consoleSink(),
    clock: systemClock,
    level: config.logLevel,
    fields: { service: config.serviceName },
  });

  const metrics = new MetricsRegistry();
  const health = new HealthMonitor([check('event-loop', () => healthy(), 'liveness')], {
    clock: systemClock,
  });

  const app = buildApp({
    logger,
    health,
    metrics,
    clock: systemClock,
    serviceName: config.serviceName,
    version: API_VERSION,
  });

  const server = createServer(toNodeListener(app));
  server.listen(config.port, config.host, () => {
    logger.info('listening', { host: config.host, port: config.port });
  });

  // Graceful shutdown: stop accepting connections, let in-flight requests drain,
  // then exit. An orchestrator sends SIGTERM; Ctrl-C sends SIGINT.
  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    server.close(() => {
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main();
