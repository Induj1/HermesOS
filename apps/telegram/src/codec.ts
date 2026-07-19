/**
 * Offline encoding / decoding / hashing helpers — the security engineer's daily
 * driver. Pure functions over Node's Buffer and crypto; bot.ts wires them to
 * /encode, /decode, and /hash.
 */

import { createHash } from 'node:crypto';

/** Supported reversible encodings. */
export const ENCODINGS = ['base64', 'base64url', 'hex', 'url'] as const;
export type Encoding = (typeof ENCODINGS)[number];

/** Supported hash algorithms. */
export const HASHES = ['md5', 'sha1', 'sha256', 'sha512'] as const;
export type HashAlgo = (typeof HASHES)[number];

function isEncoding(kind: string): kind is Encoding {
  return (ENCODINGS as readonly string[]).includes(kind);
}

function isHash(algo: string): algo is HashAlgo {
  return (HASHES as readonly string[]).includes(algo);
}

/** Encode text with the named encoding. Throws on an unknown encoding. */
export function encode(kind: string, text: string): string {
  const k = kind.toLowerCase();
  if (!isEncoding(k))
    throw new Error(`unknown encoding "${kind}" (try ${ENCODINGS.join(', ')})`);
  if (k === 'url') return encodeURIComponent(text);
  return Buffer.from(text, 'utf8').toString(k);
}

/** Decode text from the named encoding. Throws on an unknown encoding. */
export function decode(kind: string, text: string): string {
  const k = kind.toLowerCase();
  if (!isEncoding(k))
    throw new Error(`unknown encoding "${kind}" (try ${ENCODINGS.join(', ')})`);
  if (k === 'url') return decodeURIComponent(text);
  return Buffer.from(text, k).toString('utf8');
}

/** Hash text with the named algorithm, returning lowercase hex. */
export function hash(algo: string, text: string): string {
  const a = algo.toLowerCase();
  if (!isHash(a)) throw new Error(`unknown hash "${algo}" (try ${HASHES.join(', ')})`);
  return createHash(a).update(text, 'utf8').digest('hex');
}
