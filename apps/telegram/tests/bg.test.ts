import { describe, expect, it } from 'vitest';
import { isRemoveBgRequest } from '../src/bg.js';

describe('isRemoveBgRequest', () => {
  it('detects captions asking to remove the background', () => {
    for (const c of [
      'remove the background',
      'remove background',
      'removebg',
      'cut out the background',
      'knock out the bg',
      'transparent background please',
      'make a cutout',
      'no background',
    ]) {
      expect(isRemoveBgRequest(c)).toBe(true);
    }
  });
  it('ignores unrelated captions', () => {
    for (const c of ['', 'what is this?', 'make it a watercolor', 'read this']) {
      expect(isRemoveBgRequest(c)).toBe(false);
    }
  });
});
