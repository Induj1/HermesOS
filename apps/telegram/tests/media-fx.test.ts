import { describe, expect, it } from 'vitest';
import {
  isInpaintRequest,
  isUpscaleRequest,
  parseInpaintTarget,
  stemRequest,
} from '../src/media-fx.js';

describe('isUpscaleRequest', () => {
  it('detects upscale/restore captions', () => {
    for (const c of ['upscale', 'enhance this', 'restore', 'make it hd', 'sharpen']) {
      expect(isUpscaleRequest(c)).toBe(true);
    }
  });
  it('ignores unrelated captions', () => {
    for (const c of ['', 'what is this?', 'make it anime']) {
      expect(isUpscaleRequest(c)).toBe(false);
    }
  });
});

describe('isInpaintRequest / parseInpaintTarget', () => {
  it('detects erase/remove captions but not background removal', () => {
    expect(isInpaintRequest('erase the person on the left')).toBe(true);
    expect(isInpaintRequest('remove the lamp')).toBe(true);
    expect(isInpaintRequest('get rid of the sign')).toBe(true);
    expect(isInpaintRequest('remove the background')).toBe(false); // rembg's job
    expect(isInpaintRequest('what is this?')).toBe(false);
  });

  it('strips the leading verb to get the target', () => {
    expect(parseInpaintTarget('erase the person on the left')).toBe(
      'the person on the left',
    );
    expect(parseInpaintTarget('get rid of the sign')).toBe('the sign');
    expect(parseInpaintTarget('the cat')).toBe('the cat'); // no verb → whole caption
  });
});

describe('stemRequest', () => {
  it('maps captions to the requested stem', () => {
    expect(stemRequest('instrumental')).toBe('instrumental');
    expect(stemRequest('karaoke please')).toBe('instrumental');
    expect(stemRequest('remove the vocals')).toBe('instrumental');
    expect(stemRequest('vocals only')).toBe('vocals');
    expect(stemRequest('acappella')).toBe('vocals');
    expect(stemRequest('split the stems')).toBe('both');
  });
  it('returns undefined for non-stem captions', () => {
    expect(stemRequest('')).toBeUndefined();
    expect(stemRequest('transcribe this')).toBeUndefined();
  });
});
