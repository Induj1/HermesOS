import { callTool } from '@hermes/tools';
import { describe, expect, it } from 'vitest';
import { parseTranslateCommand, translateTools } from '../src/translate.js';

describe('parseTranslateCommand', () => {
  it('splits the language from the text', () => {
    expect(parseTranslateCommand(['French', 'hello', 'there'])).toEqual({
      to: 'French',
      text: 'hello there',
    });
  });
  it('returns undefined when the language or text is missing', () => {
    expect(parseTranslateCommand([])).toBeUndefined();
    expect(parseTranslateCommand(['French'])).toBeUndefined();
  });
});

describe('translateTools', () => {
  it('exposes text.translate and passes text + target to the port', async () => {
    const seen: { text: string; to: string }[] = [];
    const tool = translateTools((text, to) => {
      seen.push({ text, to });
      return Promise.resolve('bonjour');
    })[0];
    if (tool === undefined) throw new Error('text.translate tool missing');
    expect(tool.name).toBe('text.translate');
    const out = (await callTool(tool, { text: 'hello', to: 'French' })) as string;
    expect(seen).toEqual([{ text: 'hello', to: 'French' }]);
    expect(out).toBe('bonjour');
  });
});
