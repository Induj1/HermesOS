/**
 * Structured extraction: photograph a receipt, invoice, or business card and get
 * clean JSON (merchant, total, date, name, email…) instead of raw OCR text.
 *
 * The work is host-side (OCR the image, then ask the model to structure it).
 * This module is the pure part — deciding whether a photo caption is asking for
 * structured data rather than a plain read.
 */

/** Does a photo caption ask to extract structured data (JSON) from the image? */
export function isExtractRequest(caption: string): boolean {
  const c = caption.trim();
  return (
    /\b(extract|parse|structur(e|ed)|itemi[sz]e|fields?)\b/i.test(c) ||
    /\b(to|as|in) json\b/i.test(c) ||
    /\b(receipt|invoice|business ?card|name ?card)\b/i.test(c)
  );
}
