/**
 * The random id generator — correct widths and distinct ids.
 */

import { describe, expect, it } from 'vitest';
import { randomIdGenerator } from '../src/node.js';

describe('randomIdGenerator', () => {
  it('produces 32-hex trace ids and 16-hex span ids', () => {
    const ids = randomIdGenerator();
    expect(ids.traceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(ids.spanId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces distinct ids across calls', () => {
    const ids = randomIdGenerator();
    expect(ids.traceId()).not.toBe(ids.traceId());
    expect(ids.spanId()).not.toBe(ids.spanId());
  });
});
