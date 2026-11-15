import { createHmac, createPublicKey, createSign } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  JwtFormatError, b64urlDecode, b64urlEncode, buildToken, generateRsaKeyPair, hmacSignature, parseToken,
  rsaSignature, rsaVerify, safeEqual, signHmac, signRsa, strictJson,
} from './jwt.js';

const pair = generateRsaKeyPair();

describe('base64url', () => {
  it('encodes without padding using the URL alphabet', () => {
    expect(b64urlEncode(Buffer.from([0xfb, 0xff, 0xfe]))).toBe('-__-');
    expect(b64urlEncode('a')).toBe('YQ');
    expect(b64urlEncode('')).toBe('');
  });
  it('round-trips arbitrary bytes', () => {
    for (const n of [0, 1, 2, 3, 4, 31, 100]) {
      const bytes = Buffer.alloc(n, 0xab).map((_, i) => (i * 37) & 0xff);
      expect(b64urlDecode(b64urlEncode(bytes)).equals(bytes)).toBe(true);
    }
  });
  it('decodes strictly: padding, standard alphabet, whitespace and impossible lengths are errors', () => {
    for (const bad of ['YQ==', 'a+b/', 'Y Q', 'Y\nQ', 'A', 'YQ.', 'é']) {
      expect(() => b64urlDecode(bad), bad).toThrow(JwtFormatError);
    }
  });
});

describe('strictJson', () => {
  it('parses a JSON object', () => {
    expect(strictJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('rejects non-objects, arrays, junk and oversized input', () => {
    for (const bad of ['1', '"x"', 'null', '[1]', '{', '', '{"a":1} x', `{"a":"${'x'.repeat(20_000)}"}`]) {
      expect(() => strictJson(bad), bad.slice(0, 12)).toThrow(JwtFormatError);
    }
  });
  it('keeps __proto__ as plain data (no prototype pollution)', () => {
    const o = strictJson('{"__proto__":{"role":"admin"}}');
    expect(({} as Record<string, unknown>).role).toBeUndefined();
    expect(Object.getPrototypeOf(o)).toBe(Object.prototype);
    expect((o as Record<string, unknown>).role).toBeUndefined();
  });
});

describe('HMAC', () => {
  it('matches the node:crypto HMAC for each size', () => {
    for (const [alg, hash] of [['HS256', 'sha256'], ['HS384', 'sha384'], ['HS512', 'sha512']] as const) {
      expect(hmacSignature(alg, 'k', 'a.b')).toBe(createHmac(hash, 'k').update('a.b').digest('base64url'));
    }
  });
  it('accepts an empty key (some labs need it)', () => {
    expect(hmacSignature('HS256', '', 'x')).toBe(createHmac('sha256', '').update('x').digest('base64url'));
  });
  it('rejects an unknown algorithm', () => {
    expect(() => hmacSignature('HS999' as 'HS256', 'k', 'x')).toThrow(JwtFormatError);
  });
  it('signHmac builds a three-part token that parseToken reads back', () => {
    const t = signHmac('HS256', 'secret', { sub: 'a' }, { kid: '7' });
    const p = parseToken(t);
    expect(p.header).toEqual({ alg: 'HS256', typ: 'JWT', kid: '7' });
    expect(p.payload).toEqual({ sub: 'a' });
    expect(p.signature).toBe(hmacSignature('HS256', 'secret', p.signingInput));
    expect(p.signingInput).toBe(t.slice(0, t.lastIndexOf('.')));
  });
});

describe('RSA', () => {
  it('signs and verifies with PEM text, for each size', () => {
    for (const alg of ['RS256', 'RS384', 'RS512'] as const) {
      const sig = rsaSignature(alg, pair.privatePem, 'a.b');
      expect(rsaVerify(alg, pair.publicPem, 'a.b', sig), alg).toBe(true);
      expect(rsaVerify(alg, pair.publicPem, 'a.c', sig), alg).toBe(false);
    }
  });
  it('is compatible with node:crypto RSASSA-PKCS1-v1_5', () => {
    const sig = createSign('sha256').update('a.b').sign(pair.privatePem).toString('base64url');
    expect(rsaVerify('RS256', pair.publicPem, 'a.b', sig)).toBe(true);
  });
  it('accepts a KeyObject (e.g. built from a JWK)', () => {
    const jwk = createPublicKey(pair.publicPem).export({ format: 'jwk' });
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    expect(rsaVerify('RS256', key, 'a.b', rsaSignature('RS256', pair.privatePem, 'a.b'))).toBe(true);
  });
  it('a wrong key, a wrong size, a mangled or empty signature are false, never a throw', () => {
    const other = generateRsaKeyPair();
    const sig = rsaSignature('RS256', pair.privatePem, 'a.b');
    expect(rsaVerify('RS256', other.publicPem, 'a.b', sig)).toBe(false);
    expect(rsaVerify('RS384', pair.publicPem, 'a.b', sig)).toBe(false);
    expect(rsaVerify('RS256', pair.publicPem, 'a.b', '')).toBe(false);
    expect(rsaVerify('RS256', pair.publicPem, 'a.b', '!!!')).toBe(false);
    expect(rsaVerify('RS256', pair.publicPem, 'a.b', sig.slice(0, -4))).toBe(false);
  });
  it('signRsa builds a verifiable token and the key is at least 2048 bits', () => {
    const t = signRsa('RS256', pair.privatePem, { sub: 'x' });
    const p = parseToken(t);
    expect(p.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(rsaVerify('RS256', pair.publicPem, p.signingInput, p.signature)).toBe(true);
    expect(createPublicKey(pair.publicPem).asymmetricKeyDetails?.modulusLength).toBeGreaterThanOrEqual(2048);
  });
});

describe('parseToken / buildToken', () => {
  it('buildToken joins three parts; an unsigned token keeps its empty third part', () => {
    const t = buildToken({ alg: 'none' }, { a: 1 });
    expect(t.split('.')).toHaveLength(3);
    expect(t.endsWith('.')).toBe(true);
    expect(parseToken(t).signature).toBe('');
  });
  it('rejects anything that is not header.payload.signature of base64url JSON objects', () => {
    const ok = signHmac('HS256', 'k', { a: 1 });
    expect(() => parseToken(ok)).not.toThrow();
    const [h, p, s] = ok.split('.');
    for (const bad of ['', 'a', 'a.b', `${h}.${p}`, `${h}.${p}.${s}.x`, `${h}.!!.${s}`, `x.${p}.${s}`,
      `${b64urlEncode('[]')}.${p}.${s}`, `${h}.${b64urlEncode('1')}.${s}`, `${h}.${p}.${'a'.repeat(9000)}`, `${h}.${p}.a b`]) {
      expect(() => parseToken(bad), bad.slice(0, 20)).toThrow(JwtFormatError);
    }
  });
  it('is not fooled by non-strings', () => {
    expect(() => parseToken(undefined as unknown as string)).toThrow(JwtFormatError);
    expect(() => parseToken({} as unknown as string)).toThrow(JwtFormatError);
  });
});

describe('safeEqual', () => {
  it('compares strings and buffers without throwing on different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual(Buffer.from('a'), 'a')).toBe(true);
  });
});
