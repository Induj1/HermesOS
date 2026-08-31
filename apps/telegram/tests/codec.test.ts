import { describe, expect, it } from 'vitest';
import { decode, encode, hash } from '../src/codec.js';

describe('encode / decode', () => {
  it('round-trips every encoding', () => {
    for (const kind of ['base64', 'base64url', 'hex', 'url']) {
      expect(decode(kind, encode(kind, 'héllo world/?='))).toBe('héllo world/?=');
    }
  });
  it('matches known values and is case-insensitive on the kind', () => {
    expect(encode('base64', 'hi')).toBe('aGk=');
    expect(encode('HEX', 'A')).toBe('41');
    expect(encode('url', 'a b')).toBe('a%20b');
  });
  it('throws on an unknown encoding', () => {
    expect(() => encode('rot13', 'x')).toThrow(/unknown encoding/);
    expect(() => decode('rot13', 'x')).toThrow(/unknown encoding/);
  });
});

describe('hash', () => {
  it('hashes with known algorithms', () => {
    expect(hash('sha256', 'abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hash('md5', 'abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });
  it('throws on an unknown algorithm', () => {
    expect(() => hash('crc32', 'x')).toThrow(/unknown hash/);
  });
});
