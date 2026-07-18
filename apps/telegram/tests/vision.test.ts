import { describe, expect, it } from 'vitest';
import { largestPhoto, visionPrompt } from '../src/vision.js';

describe('largestPhoto', () => {
  it('returns undefined when there are no photos', () => {
    expect(largestPhoto(undefined)).toBeUndefined();
    expect(largestPhoto([])).toBeUndefined();
  });

  it('picks the highest-resolution size', () => {
    const chosen = largestPhoto([
      { file_id: 's', width: 90, height: 90 },
      { file_id: 'l', width: 800, height: 600 },
      { file_id: 'm', width: 320, height: 240 },
    ]);
    expect(chosen?.file_id).toBe('l');
  });

  it('treats missing dimensions as zero area', () => {
    const chosen = largestPhoto([
      { file_id: 'nodim' },
      { file_id: 'big', width: 100, height: 100 },
    ]);
    expect(chosen?.file_id).toBe('big');
  });
});

describe('visionPrompt', () => {
  it('uses the caption when present', () => {
    expect(visionPrompt('what is this?')).toBe('what is this?');
  });

  it('falls back to a default prompt when blank', () => {
    expect(visionPrompt('   ')).toMatch(/Describe this image/);
  });
});
