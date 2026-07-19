import { describe, expect, it } from 'vitest';
import { isExtractRequest } from '../src/extract.js';

describe('isExtractRequest', () => {
  it('detects captions asking for structured extraction', () => {
    for (const c of [
      'extract the fields',
      'parse this',
      'structured data please',
      'receipt',
      'invoice to json',
      'business card',
      'itemize this',
      'as json',
    ]) {
      expect(isExtractRequest(c)).toBe(true);
    }
  });
  it('ignores unrelated captions', () => {
    for (const c of ['', 'what is this?', 'read this', 'remove background']) {
      expect(isExtractRequest(c)).toBe(false);
    }
  });
});
