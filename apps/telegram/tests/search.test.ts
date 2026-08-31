import { FakeHttpClient } from '@hermes/tools-http';
import { callTool } from '@hermes/tools';
import { describe, expect, it } from 'vitest';
import { formatResults, parseDuckDuckGo, searchTools } from '../src/search.js';

const HTML = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x">First &amp; Best</a>
  <a class="result__snippet">A great <b>first</b> result.</a>
</div>
<div class="result">
  <a class="result__a" href="https://example.org/b">Second Result</a>
  <a class="result__snippet">Another snippet.</a>
</div>
<div class="result">
  <a class="result__a" href="//example.net/c">Third Result</a>
</div>`;

function firstTool(http: FakeHttpClient) {
  const tool = searchTools(http)[0];
  if (tool === undefined) throw new Error('search tool missing');
  return tool;
}

describe('parseDuckDuckGo', () => {
  it('extracts title, decoded url, and snippet across url shapes', () => {
    const results = parseDuckDuckGo(HTML, 5);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      title: 'First & Best',
      url: 'https://example.com/a',
      snippet: 'A great first result.',
    });
    expect(results[1]?.url).toBe('https://example.org/b'); // plain href
    expect(results[2]?.url).toBe('https://example.net/c'); // protocol-relative
    expect(results[2]?.snippet).toBe(''); // no snippet for the third
  });

  it('respects the limit', () => {
    expect(parseDuckDuckGo(HTML, 1)).toHaveLength(1);
  });
});

describe('formatResults', () => {
  it('numbers results and reports emptiness', () => {
    expect(formatResults([])).toBe('No results found.');
    expect(formatResults([{ title: 'T', url: 'U', snippet: 'S' }])).toContain('1. T');
  });
});

describe('web.search tool', () => {
  it('queries and formats results', async () => {
    const http = new FakeHttpClient({
      handle: () => ({ status: 200, body: HTML }),
    });
    const out = (await callTool(firstTool(http), {
      query: 'example',
      count: 5,
    })) as string;
    expect(out).toContain('First & Best');
    expect(out).toContain('https://example.com/a');
  });

  it('throws on an error status', async () => {
    const http = new FakeHttpClient({ handle: () => ({ status: 503, body: '' }) });
    await expect(callTool(firstTool(http), { query: 'x', count: 3 })).rejects.toThrow(
      /search failed/,
    );
  });
});
