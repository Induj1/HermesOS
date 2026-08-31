/**
 * A document tool: render an HTML document to a PDF saved in the workspace.
 *
 * The model is good at writing HTML, so the tool takes HTML and hands it to an
 * injected `renderPdf` port (Playwright's page.pdf, in main.ts). The saved file
 * is downloaded with /get. Injecting the port keeps this a testable unit.
 */

import { defineTool, s } from '@hermes/tools';
import type { HermesTool } from '@hermes/tools';

/** Render an HTML string to a PDF file; returns the saved (relative) filename. */
export type RenderPdfPort = (html: string, filename: string) => Promise<string>;

/** A `doc.pdf` tool over the given render port. */
export function docTools(renderPdf: RenderPdfPort): readonly HermesTool[] {
  const pdf = defineTool({
    name: 'doc.pdf',
    description:
      'Render an HTML document to a PDF saved in the workspace. Pass a full HTML ' +
      'document as `html`. Tell the user to download it with /get <filename>.',
    tags: ['document', 'pdf'],
    input: s.object({
      html: s.string({ description: 'A complete HTML document to render.' }),
      filename: s.string({ description: 'Output filename, e.g. report.pdf' }),
    }),
    output: s.string(),
    execute: async ({ html, filename }) => {
      const saved = await renderPdf(html, filename);
      return `Saved ${saved} — the user can download it with /get ${saved}`;
    },
  });
  return [pdf];
}
