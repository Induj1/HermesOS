/**
 * QR codes: generate one from text (the /qr command) and read one out of a photo
 * (a photo captioned "scan qr"). Both run host-side over the Python venv; this
 * module is the pure part — deciding whether a photo caption asks to scan a QR.
 */

/** Does a photo caption ask to scan/decode a QR code? */
export function isQrScanRequest(caption: string): boolean {
  const c = caption.trim();
  return (
    /\b(scan|read|decode)( the| this)? qr( ?code)?\b/i.test(c) ||
    /\bwhat('?s| is)( in)? (this|the) qr\b/i.test(c)
  );
}
