import { callTool } from '@hermes/tools';
import { describe, expect, it } from 'vitest';
import { isOcrRequest, ocrTools } from '../src/ocr.js';

describe('isOcrRequest', () => {
  it('detects captions asking to read/extract text', () => {
    for (const c of [
      'ocr',
      'read this',
      'read the text',
      'extract the text',
      'what does this say',
      'transcribe this receipt',
      'scan this document',
    ]) {
      expect(isOcrRequest(c)).toBe(true);
    }
  });
  it('ignores captions that do not ask for OCR', () => {
    for (const c of ['', 'make it anime', 'what breed is this dog?', 'nice photo']) {
      expect(isOcrRequest(c)).toBe(false);
    }
  });
});

describe('ocrTools', () => {
  it('exposes image.ocr and calls the run port with the path', async () => {
    let seen: string | undefined;
    const tool = ocrTools((p) => {
      seen = p;
      return Promise.resolve('hello world');
    })[0];
    if (tool === undefined) throw new Error('image.ocr tool missing');
    expect(tool.name).toBe('image.ocr');
    const out = (await callTool(tool, { path: 'scan.png' })) as string;
    expect(seen).toBe('scan.png');
    expect(out).toBe('hello world');
  });
});
