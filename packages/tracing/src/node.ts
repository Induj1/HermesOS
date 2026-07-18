/**
 * The Node id generator — cryptographically random trace and span ids. Isolated
 * here so the rest of the package stays deterministic (the tracer takes an
 * injected `IdGenerator`); production wires this one in.
 */

import { randomBytes } from 'node:crypto';
import type { IdGenerator } from './ids.js';

/** A random `IdGenerator`: 16 random bytes for a trace id, 8 for a span id. */
export function randomIdGenerator(): IdGenerator {
  return {
    traceId: () => randomBytes(16).toString('hex'),
    spanId: () => randomBytes(8).toString('hex'),
  };
}
