import { callTool } from '@hermes/tools';
import { describe, expect, it } from 'vitest';
import { pythonTools } from '../src/python.js';

describe('pythonTools', () => {
  it('runs code via the injected port and returns its output', async () => {
    let seen: string | undefined;
    const tool = pythonTools((code) => {
      seen = code;
      return Promise.resolve('42\n');
    })[0];
    if (tool === undefined) throw new Error('python.run tool missing');

    const out = (await callTool(tool, { code: 'print(6 * 7)' })) as string;
    expect(seen).toBe('print(6 * 7)');
    expect(out).toBe('42\n');
  });
});
