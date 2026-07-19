/**
 * OCR: read the text out of an image.
 *
 * Two surfaces. A photo sent to the bot with a caption like "read this" is
 * detected by `isOcrRequest` and OCR'd host-side (main.ts downloads it and runs
 * Tesseract). And `image.ocr` is a tool the agent can call on a file already in
 * the workspace — e.g. to pull text out of a scanned page it just saved.
 *
 * This module is the pure part: the caption heuristic and the tool definition
 * over an injected run port.
 */

import { defineTool, s } from '@hermes/tools';
import type { HermesTool } from '@hermes/tools';

/** Run OCR on a workspace image path, returning the extracted text. */
export type OcrRunPort = (workspacePath: string) => Promise<string>;

/** Does a photo caption ask to read/extract the text in the image? */
export function isOcrRequest(caption: string): boolean {
  const c = caption.trim();
  return (
    /\b(ocr|read (this|it)\b|read (the |any |this )?text|extract (the |any )?text|what does (this|it) say|scan (this|the))/i.test(
      c,
    ) ||
    /\btranscribe (this|the) (image|photo|picture|document|page|receipt|screenshot)/i.test(
      c,
    )
  );
}

/** An `image.ocr` tool that reads text from an image already in the workspace. */
export function ocrTools(run: OcrRunPort): readonly HermesTool[] {
  const tool = defineTool({
    name: 'image.ocr',
    description:
      'Read the text out of an image file in the workspace using OCR. Give the ' +
      'file path (e.g. "scan.png" or "receipt.jpg"). Returns the extracted text.',
    tags: ['ocr', 'image'],
    input: s.object({
      path: s.string({ description: 'Workspace path to the image file.' }),
    }),
    output: s.string(),
    execute: ({ path }) => run(path),
  });
  return [tool];
}
