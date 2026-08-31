/**
 * Translation: turn text into another language with the local model — no cloud,
 * no extra dependency, it reuses the Ollama model the agent already runs on.
 *
 * The pure part is the tool definition (over an injected port) and the parser
 * for the `/translate` command. The port itself — a raw model call — lives in
 * main.ts.
 */

import { defineTool, s } from '@hermes/tools';
import type { HermesTool } from '@hermes/tools';

/** Translate `text` into `targetLang`, returning only the translation. */
export type TranslatePort = (text: string, targetLang: string) => Promise<string>;

/** A `text.translate` tool the agent can call to translate arbitrary text. */
export function translateTools(translate: TranslatePort): readonly HermesTool[] {
  const tool = defineTool({
    name: 'text.translate',
    description:
      'Translate text into another language using the local model. Give the text ' +
      'and the target language (e.g. "French", "Hindi", "Japanese"). Returns only ' +
      'the translated text.',
    tags: ['translate', 'language'],
    input: s.object({
      text: s.string({ description: 'The text to translate.' }),
      to: s.string({ description: 'Target language, e.g. "Spanish".' }),
    }),
    output: s.string(),
    execute: ({ text, to }) => translate(text, to),
  });
  return [tool];
}

/** Parse `/translate <language> <text…>` into its parts (undefined if malformed). */
export function parseTranslateCommand(
  args: readonly string[],
): { to: string; text: string } | undefined {
  const [to, ...rest] = args;
  if (to === undefined || rest.length === 0) return undefined;
  return { to, text: rest.join(' ') };
}
