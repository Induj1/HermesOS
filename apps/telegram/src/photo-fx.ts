/**
 * Photo studio: quick host-side image effects triggered by a photo's caption —
 * blurring faces for privacy, adding meme captions, and turning a photo into a
 * sticker. This module is the pure part: recognising each request from the
 * caption and parsing the meme's top/bottom text.
 */

/** Does a photo caption ask to blur/censor the faces? */
export function isBlurFacesRequest(caption: string): boolean {
  return /\b(blur|censor|hide|pixel(ate|ize)|anonymi[sz]e) (the |all )?faces?\b/i.test(
    caption.trim(),
  );
}

/** Does a photo caption ask to turn the image into a sticker? */
export function isStickerRequest(caption: string): boolean {
  return /\b(make (a|it) |as (a )?|turn into (a )?)?sticker\b/i.test(caption.trim());
}

/** Does a photo caption ask to make a meme? */
export function isMemeRequest(caption: string): boolean {
  return /^\s*meme\b/i.test(caption);
}

/**
 * Parse a meme caption into top/bottom text. Strips the leading "meme" (and an
 * optional ":") and splits the rest on "|"; a single part becomes the top line.
 */
export function parseMeme(caption: string): { top: string; bottom: string } {
  const body = caption
    .trim()
    .replace(/^meme\b:?/i, '')
    .trim();
  const parts = body.split('|').map((p) => p.trim());
  const top = parts[0] ?? '';
  const bottom = parts.length > 1 ? parts.slice(1).join(' | ').trim() : '';
  return { top, bottom };
}
