import { callTool } from '@hermes/tools';
import { describe, expect, it } from 'vitest';
import { docTools } from '../src/doc.js';

describe('docTools', () => {
  it('renders via the port and tells the user how to download', async () => {
    let seen: { html: string; filename: string } | undefined;
    const tool = docTools((html, filename) => {
      seen = { html, filename };
      return Promise.resolve('report.pdf');
    })[0];
    if (tool === undefined) throw new Error('doc.pdf tool missing');

    const out = (await callTool(tool, {
      html: '<h1>Hi</h1>',
      filename: 'report.pdf',
    })) as string;

    expect(seen).toEqual({ html: '<h1>Hi</h1>', filename: 'report.pdf' });
    expect(out).toContain('/get report.pdf');
  });
});
