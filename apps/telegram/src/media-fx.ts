/**
 * Heavier media effects triggered by a caption: AI upscale/restore, object
 * removal (text-guided inpainting), and splitting a song into vocals and
 * instrumental. The work is host-side (main.ts, over the torch venv); this
 * module is the pure part — recognising each request and parsing its argument.
 */

/** Which stem(s) a caption is asking for. */
export type StemChoice = 'vocals' | 'instrumental' | 'both';

/** Does a photo caption ask to upscale / restore / enhance the image? */
export function isUpscaleRequest(caption: string): boolean {
  return /\b(upscale|super.?res(olution)?|enhance|restore|sharpen|un ?blur|de ?blur|increase (the )?resolution|higher res(olution)?|make (it )?hd)\b/i.test(
    caption.trim(),
  );
}

/**
 * Does a photo caption ask to erase an object (inpaint)? Excludes background
 * removal, which is handled separately by rembg.
 */
export function isInpaintRequest(caption: string): boolean {
  const c = caption.trim();
  if (/\bbackground\b|\bbg\b/i.test(c)) return false;
  return /\b(erase|inpaint|remove|delete|get rid of|clean up)\b/i.test(c);
}

/** The object phrase to erase, with the leading verb stripped. */
export function parseInpaintTarget(caption: string): string {
  const stripped = caption
    .trim()
    .replace(/^(please\s+)?(erase|inpaint|remove|delete|get rid of|clean up)\s+/i, '')
    .trim();
  return stripped === '' ? caption.trim() : stripped;
}

/** Which stem a media caption asks for, or undefined if it is not a stem request. */
export function stemRequest(caption: string): StemChoice | undefined {
  const c = caption.trim();
  if (
    /\b(vocals? only|just (the )?vocals|a ?cappella|isolate (the )?vocals)\b/i.test(c)
  ) {
    return 'vocals';
  }
  if (
    /\b(instrumental|karaoke|remove (the )?vocals|without vocals|no vocals|backing track|minus one)\b/i.test(
      c,
    )
  ) {
    return 'instrumental';
  }
  if (/\b(split|stems?|separate|isolate)\b/i.test(c)) return 'both';
  return undefined;
}
