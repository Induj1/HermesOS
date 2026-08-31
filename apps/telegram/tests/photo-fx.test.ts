import { describe, expect, it } from 'vitest';
import {
  isBlurFacesRequest,
  isMemeRequest,
  isStickerRequest,
  parseMeme,
} from '../src/photo-fx.js';

describe('isBlurFacesRequest', () => {
  it('detects face-blur captions', () => {
    for (const c of [
      'blur faces',
      'blur the faces',
      'censor faces',
      'pixelate faces',
    ]) {
      expect(isBlurFacesRequest(c)).toBe(true);
    }
  });
  it('ignores unrelated captions', () => {
    for (const c of ['', 'blur the background', 'what is this?']) {
      expect(isBlurFacesRequest(c)).toBe(false);
    }
  });
});

describe('isStickerRequest', () => {
  it('detects sticker captions', () => {
    for (const c of [
      'sticker',
      'make a sticker',
      'turn into a sticker',
      'as a sticker',
    ]) {
      expect(isStickerRequest(c)).toBe(true);
    }
  });
  it('ignores unrelated captions', () => {
    expect(isStickerRequest('')).toBe(false);
    expect(isStickerRequest('what is this?')).toBe(false);
  });
});

describe('isMemeRequest / parseMeme', () => {
  it('detects meme captions only at the start', () => {
    expect(isMemeRequest('meme: hello | world')).toBe(true);
    expect(isMemeRequest('meme top only')).toBe(true);
    expect(isMemeRequest('make a meme')).toBe(false);
  });

  it('splits top and bottom on the pipe', () => {
    expect(parseMeme('meme: top text | bottom text')).toEqual({
      top: 'top text',
      bottom: 'bottom text',
    });
    expect(parseMeme('meme just the top')).toEqual({ top: 'just the top', bottom: '' });
    expect(parseMeme('meme: a | b | c')).toEqual({ top: 'a', bottom: 'b | c' });
  });
});
