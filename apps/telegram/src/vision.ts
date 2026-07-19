/**
 * Image input: when a photo arrives, describe it with a local vision model.
 *
 * The @hermes/telegram types don't model photos and @hermes/model is text-only,
 * so this stays host-side: main.ts downloads the photo via the raw Telegram Bot
 * API and calls Ollama's native /api/chat with an `images` field. This module is
 * the pure part — picking the best photo size and wording the prompt.
 */

/** A Telegram PhotoSize (untyped by @hermes/telegram; present on the raw update). */
export interface PhotoSize {
  readonly file_id: string;
  readonly width?: number;
  readonly height?: number;
  readonly file_size?: number;
}

/** The highest-resolution photo in a size set (Telegram sends several). */
export function largestPhoto(
  photos: readonly PhotoSize[] | undefined,
): PhotoSize | undefined {
  if (photos === undefined || photos.length === 0) return undefined;
  return [...photos].sort(
    (a, b) => (a.width ?? 0) * (a.height ?? 0) - (b.width ?? 0) * (b.height ?? 0),
  )[photos.length - 1];
}

/** Does a photo caption ask to *transform* the image (img2img) vs describe it? */
export function isTransformRequest(caption: string): boolean {
  return /\b(make|turn|convert|transform|redraw|restyle|reimagine|styli[sz]e|as an?|in the style of|watercolou?r|anime|cartoon|oil painting|sketch|pixar|cyberpunk|van gogh|painting|render)\b/i.test(
    caption.trim(),
  );
}

/** The prompt to send with an image — the caption, or a sensible default. */
export function visionPrompt(caption: string): string {
  const trimmed = caption.trim();
  if (trimmed !== '') return trimmed;
  return (
    'Describe this image in detail. If it is a UI sketch, describe the layout so it ' +
    'could be built; if it shows code or an error, explain it; otherwise summarise it.'
  );
}
