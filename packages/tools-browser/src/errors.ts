/**
 * Browser errors.
 *
 * A `BrowserError` means an operation could not complete: a selector never
 * appeared, a navigation failed, a wait timed out, a dialog went unhandled. The
 * codes are stable so a caller (and a tool) can branch without matching prose,
 * and they mirror the failure modes a real Playwright driver produces — so the
 * fake and a future real backend raise the same errors, which is what makes the
 * backend swappable (RFC-0012 §6).
 */

export type BrowserErrorCode =
  | 'NAVIGATION_FAILED'
  | 'TIMEOUT'
  | 'SELECTOR_NOT_FOUND'
  | 'NOT_INTERACTABLE'
  | 'DIALOG_UNHANDLED'
  | 'TARGET_CLOSED'
  | 'DOWNLOAD_FAILED'
  | 'UPLOAD_FAILED'
  | 'BROWSER_ERROR';

export class BrowserError extends Error {
  readonly code: BrowserErrorCode;
  /** The selector or URL the operation was about, when there was one. */
  readonly target: string | undefined;

  constructor(
    code: BrowserErrorCode,
    message: string,
    options?: ErrorOptions & { target?: string },
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.target = options?.target;
  }
}
