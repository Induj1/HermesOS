/**
 * The API service's configuration schema — declared once, read from the
 * environment via `@hermes/config`. This is the whole set of knobs the service
 * takes; the deployment supplies them (see `docs/deployment`).
 */

import { oneOf, port, string, type Config } from '@hermes/config';

export const apiSchema = {
  /** The TCP port to listen on. `PORT`. */
  port: port().default(3000),
  /** Minimum log level. `LOG_LEVEL`. */
  logLevel: oneOf(['debug', 'info', 'warn', 'error']).default('info'),
  /** A name stamped on every log line. `SERVICE_NAME`. */
  serviceName: string().default('hermes-api'),
};

export type ApiConfig = Config<typeof apiSchema>;

/** The service version, surfaced at `/` and on the startup log line. */
export const API_VERSION = '0.0.0';
