/**
 * The browser error shape.
 */

import { describe, expect, it } from 'vitest';
import { BrowserError } from '../src/errors.js';

describe('BrowserError', () => {
  it('carries a stable code and an optional target', () => {
    const err = new BrowserError('SELECTOR_NOT_FOUND', 'no match', { target: '#x' });
    expect(err.code).toBe('SELECTOR_NOT_FOUND');
    expect(err.target).toBe('#x');
    expect(err.name).toBe('BrowserError');
    expect(err).toBeInstanceOf(Error);
  });

  it('has no target when none is given', () => {
    expect(new BrowserError('BROWSER_ERROR', 'x').target).toBeUndefined();
  });

  it('preserves a cause', () => {
    const cause = new Error('root');
    expect(new BrowserError('NAVIGATION_FAILED', 'x', { cause }).cause).toBe(cause);
  });
});
