/**
 * A web-search tool for the agent.
 *
 * The agent can already `http.get` a known URL; this lets it *find* URLs. It
 * queries DuckDuckGo's HTML endpoint and parses the results — a scrape, so the
 * parser is isolated and tested, and will need a tweak if DDG changes its markup.
 */

import { defineTool, s } from '@hermes/tools';
import type { HermesTool } from '@hermes/tools';
import type { HttpClient } from '@hermes/tools-http';

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

function clean(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** DDG wraps result links in a redirect carrying the real URL in `uddg`. */
function realUrl(href: string): string {
  const match = /[?&]uddg=([^&]+)/.exec(href);
  if (match?.[1] !== undefined) return decodeURIComponent(match[1]);
  if (href.startsWith('//')) return `https:${href}`;
  return href;
}

/** Parse DuckDuckGo's HTML results into structured hits. */
export function parseDuckDuckGo(html: string, limit: number): readonly SearchResult[] {
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  for (let m = snippetRe.exec(html); m !== null; m = snippetRe.exec(html)) {
    snippets.push(clean(m[1] ?? ''));
  }

  const anchorRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const results: SearchResult[] = [];
  let index = 0;
  for (
    let m = anchorRe.exec(html);
    m !== null && results.length < limit;
    m = anchorRe.exec(html)
  ) {
    results.push({
      title: clean(m[2] ?? ''),
      url: realUrl(m[1] ?? ''),
      snippet: snippets[index] ?? '',
    });
    index += 1;
  }
  return results;
}

/** Format results for a chat reply / model context. */
export function formatResults(results: readonly SearchResult[]): string {
  if (results.length === 0) return 'No results found.';
  return results
    .map((r, i) => `${String(i + 1)}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join('\n');
}

/** A `web.search` tool over the given HTTP client. */
export function searchTools(http: HttpClient): readonly HermesTool[] {
  const search = defineTool({
    name: 'web.search',
    description:
      'Search the web and return the top results (title, url, snippet). Use this ' +
      'to find current information, then http.get a result URL for the details.',
    tags: ['web', 'search'],
    idempotent: true,
    input: s.object({
      query: s.string({ description: 'The search query.' }),
      count: s.withDefault(s.number({ integer: true, minimum: 1 }), 5),
    }),
    output: s.string(),
    execute: async ({ query, count }) => {
      const res = await http.request({
        url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        headers: { 'user-agent': 'Mozilla/5.0 (hermes-telegram)' },
      });
      if (res.status >= 400)
        throw new Error(`search failed: HTTP ${String(res.status)}`);
      return formatResults(parseDuckDuckGo(res.body, count));
    },
  });
  return [search];
}
