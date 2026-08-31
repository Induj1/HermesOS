/**
 * A browser tool: open a URL in a real (headless) browser and read the rendered
 * text. Unlike http.get, this runs JavaScript, so it works on SPAs and pages
 * that build their content client-side.
 *
 * The Playwright call is injected as a `browse` port so this stays a pure,
 * testable unit; main.ts supplies the real headless-Chromium implementation.
 */

import { defineTool, s } from '@hermes/tools';
import type { HermesTool } from '@hermes/tools';

/** Fetch the rendered text of a page, capped at `maxChars`. */
export type BrowsePort = (url: string, maxChars: number) => Promise<string>;

/** A `web.browse` tool over the given browse port. */
export function browserTools(browse: BrowsePort): readonly HermesTool[] {
  const tool = defineTool({
    name: 'web.browse',
    description:
      'Open a URL in a real browser and return the rendered page text. Use this ' +
      'for pages that need JavaScript to render; otherwise prefer http.get.',
    tags: ['web', 'browser'],
    idempotent: true,
    input: s.object({
      url: s.string({ description: 'The page URL.' }),
      maxChars: s.withDefault(s.number({ integer: true, minimum: 1 }), 4000),
    }),
    output: s.string(),
    execute: ({ url, maxChars }) => browse(url, maxChars),
  });
  return [tool];
}
