/**
 * Diagram generation: turn a description into a real rendered diagram.
 *
 * The agent writes Mermaid source and calls `diagram.render`, which rasterises
 * it to a PNG in the workspace (host-side, via headless Chromium + a vendored
 * mermaid.js). The user then pulls it back with /get — the same flow as charts.
 *
 * This module is the pure part: the tool definition over an injected render port.
 */

import { defineTool, s } from '@hermes/tools';
import type { HermesTool } from '@hermes/tools';

/** Render Mermaid source to a PNG file in the workspace; returns its filename. */
export type DiagramRenderPort = (mermaid: string, filename: string) => Promise<string>;

/** A `diagram.render` tool that draws Mermaid diagrams (flowcharts, sequence, ER…). */
export function diagramTools(render: DiagramRenderPort): readonly HermesTool[] {
  const tool = defineTool({
    name: 'diagram.render',
    description:
      'Render a Mermaid diagram to a PNG in the workspace. Give valid Mermaid ' +
      'source (e.g. "graph TD; A[Start]-->B[End]") and a filename like "flow.png". ' +
      'Use it for flowcharts, sequence diagrams, ER diagrams, mind maps, gantt ' +
      'charts, and the like. After it renders, tell the user to download it with ' +
      '/get <filename>. Returns the saved filename.',
    tags: ['diagram', 'mermaid'],
    input: s.object({
      mermaid: s.string({ description: 'The Mermaid diagram source.' }),
      filename: s.string({ description: 'Output PNG filename, e.g. "flow.png".' }),
    }),
    output: s.string(),
    execute: ({ mermaid, filename }) => render(mermaid, filename),
  });
  return [tool];
}
