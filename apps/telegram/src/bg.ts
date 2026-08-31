/**
 * Background removal: turn a photo into a transparent-background cutout.
 *
 * The work is a local `rembg` model run host-side (main.ts). This module is the
 * pure part — deciding, from a photo's caption, whether the user is asking for a
 * cutout rather than a description or a stylistic transform.
 */

/** Does a photo caption ask to remove/knock out the background? */
export function isRemoveBgRequest(caption: string): boolean {
  const c = caption.trim();
  return (
    /\b(remove|cut ?out|delete|strip|erase|knock ?out|drop) (the )?(background|bg)\b/i.test(
      c,
    ) || /\b(remove ?bg|no background|transparent background|cutout)\b/i.test(c)
  );
}
