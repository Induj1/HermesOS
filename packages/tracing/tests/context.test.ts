/**
 * W3C traceparent — format, parse, validation, and round-trip.
 */

import { describe, expect, it } from 'vitest';
import { formatTraceparent, parseTraceparent } from '../src/context.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';

describe('formatTraceparent', () => {
  it('renders the sampled and unsampled flag', () => {
    expect(formatTraceparent({ traceId: TRACE, spanId: SPAN, sampled: true })).toBe(
      `00-${TRACE}-${SPAN}-01`,
    );
    expect(formatTraceparent({ traceId: TRACE, spanId: SPAN, sampled: false })).toBe(
      `00-${TRACE}-${SPAN}-00`,
    );
  });
});

describe('parseTraceparent', () => {
  it('parses a valid header and reads the sampled bit', () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01`)).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      sampled: true,
    });
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-00`)?.sampled).toBe(false);
  });

  it('reads sampled from bit 0 of the flags byte', () => {
    // 0xff has bit 0 set → sampled; 0xfe does not.
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-ff`)?.sampled).toBe(true);
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-fe`)?.sampled).toBe(false);
  });

  it('trims surrounding whitespace', () => {
    expect(parseTraceparent(`  00-${TRACE}-${SPAN}-01  `)?.traceId).toBe(TRACE);
  });

  it('rejects malformed headers', () => {
    expect(parseTraceparent('')).toBeUndefined();
    expect(parseTraceparent('garbage')).toBeUndefined();
    expect(parseTraceparent(`01-${TRACE}-${SPAN}-01`)).toBeUndefined(); // bad version
    expect(parseTraceparent(`00-${TRACE}-${SPAN}`)).toBeUndefined(); // missing flags
    expect(parseTraceparent(`00-${TRACE.slice(0, 30)}-${SPAN}-01`)).toBeUndefined(); // short trace
    expect(
      parseTraceparent(`00-${TRACE.replace('4', 'z')}-${SPAN}-01`),
    ).toBeUndefined(); // non-hex
  });

  it('rejects the all-zero trace or span id', () => {
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${SPAN}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${TRACE}-${'0'.repeat(16)}-01`)).toBeUndefined();
  });

  it('round-trips with formatTraceparent', () => {
    const ctx = { traceId: TRACE, spanId: SPAN, sampled: true };
    expect(parseTraceparent(formatTraceparent(ctx))).toEqual(ctx);
  });
});
