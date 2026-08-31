import { callTool } from '@hermes/tools';
import { describe, expect, it } from 'vitest';
import { diagramTools } from '../src/diagram.js';

describe('diagramTools', () => {
  it('exposes diagram.render and passes source + filename to the port', async () => {
    const seen: { mermaid: string; filename: string }[] = [];
    const tool = diagramTools((mermaid, filename) => {
      seen.push({ mermaid, filename });
      return Promise.resolve(filename);
    })[0];
    if (tool === undefined) throw new Error('diagram.render tool missing');
    expect(tool.name).toBe('diagram.render');

    const out = (await callTool(tool, {
      mermaid: 'graph TD; A-->B',
      filename: 'flow.png',
    })) as string;
    expect(seen).toEqual([{ mermaid: 'graph TD; A-->B', filename: 'flow.png' }]);
    expect(out).toBe('flow.png');
  });
});
