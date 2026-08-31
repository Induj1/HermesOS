import { callTool } from '@hermes/tools';
import { describe, expect, it } from 'vitest';
import { browserTools } from '../src/browser.js';

describe('browserTools', () => {
  it('exposes web.browse over the injected port', async () => {
    let seen: { url: string; maxChars: number } | undefined;
    const tool = browserTools((url, maxChars) => {
      seen = { url, maxChars };
      return Promise.resolve('rendered page text');
    })[0];
    if (tool === undefined) throw new Error('browse tool missing');

    const out = (await callTool(tool, {
      url: 'https://x.com',
      maxChars: 100,
    })) as string;
    expect(out).toBe('rendered page text');
    expect(seen).toEqual({ url: 'https://x.com', maxChars: 100 });
  });
});
