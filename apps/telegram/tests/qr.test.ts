import { describe, expect, it } from 'vitest';
import { isQrScanRequest } from '../src/qr.js';

describe('isQrScanRequest', () => {
  it('detects captions asking to scan a QR code', () => {
    for (const c of [
      'scan qr',
      'scan this qr code',
      'read the qr',
      'decode qr code',
      "what's in this qr",
      'what is in the qr',
    ]) {
      expect(isQrScanRequest(c)).toBe(true);
    }
  });
  it('ignores unrelated captions', () => {
    for (const c of ['', 'read this', 'what is this?', 'remove background']) {
      expect(isQrScanRequest(c)).toBe(false);
    }
  });
});
