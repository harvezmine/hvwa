// _shared/jwt.ts — SAFE JWT primitives shared by the Gatekeeper JWT labs (GK-04 … GK-07).
// Only mechanics that are correct on their own live here: base64url, strict JSON, HMAC and RSA signing and
// verifying of a given input, token (de)composition, a timing-safe compare, key generation.
// The flaws (which algorithm to trust, which key to use, whether to check at all) are NEVER here: every
// level's verify function is hand-rolled in its own levels/<level>.ts, so View Source and the Diff teach them.
import { createHmac, createPublicKey, createSign, createVerify, generateKeyPairSync, timingSafeEqual, type KeyObject } from 'node:crypto';

/** Thrown for anything that is not a well-formed token or encoding. The message is safe to show. */
export class JwtFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtFormatError';
  }
}

export type HmacAlg = 'HS256' | 'HS384' | 'HS512';
export type RsaAlg = 'RS256' | 'RS384' | 'RS512';

const HMAC_HASH: Readonly<Record<HmacAlg, string>> = Object.freeze({ HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' });
const RSA_HASH: Readonly<Record<RsaAlg, string>> = Object.freeze({ RS256: 'sha256', RS384: 'sha384', RS512: 'sha512' });

/** Type guards: own-property checks only, so 'constructor' or '__proto__' are never algorithms. */
export const isHmacAlg = (x: unknown): x is HmacAlg => typeof x === 'string' && Object.hasOwn(HMAC_HASH, x);
export const isRsaAlg = (x: unknown): x is RsaAlg => typeof x === 'string' && Object.hasOwn(RSA_HASH, x);

const MAX_TOKEN = 8192;
const MAX_JSON = 16384;
const B64URL = /^[A-Za-z0-9_-]*$/;

/** Base64url without padding. */
export function b64urlEncode(data: string | Uint8Array): string {
  return Buffer.from(data).toString('base64url');
}

/** Strict base64url decode: URL alphabet only, no padding, no whitespace, no impossible length, canonical form only. */
export function b64urlDecode(text: string): Buffer {
  if (typeof text !== 'string' || !B64URL.test(text) || text.length % 4 === 1) throw new JwtFormatError('malformed base64url');
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) throw new JwtFormatError('non-canonical base64url'); // ignored trailing bits
  return bytes;
}

/** Parse JSON text that must be a single plain object (not an array, number, null ...). */
export function strictJson(text: string): Record<string, unknown> {
  if (typeof text !== 'string' || text.length > MAX_JSON) throw new JwtFormatError('malformed JSON');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new JwtFormatError('malformed JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new JwtFormatError('JSON object expected');
  return value as Record<string, unknown>;
}

/** A token taken apart. Nothing here has been verified. */
export interface ParsedToken {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  /** The signature segment exactly as sent (base64url text; '' for an unsigned token). */
  readonly signature: string;
  /** `<header segment>.<payload segment>`: what a signature covers. */
  readonly signingInput: string;
}

/** Split `header.payload.signature`; header and payload must be base64url JSON objects. Does NOT verify. */
export function parseToken(token: string): ParsedToken {
  if (typeof token !== 'string' || token.length > MAX_TOKEN) throw new JwtFormatError('malformed token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtFormatError('a token has three parts');
  const [h, p, s] = parts;
  b64urlDecode(s); // a signature segment must be canonical base64url too ('' is fine: an unsigned token)
  return {
    header: strictJson(b64urlDecode(h).toString('utf8')),
    payload: strictJson(b64urlDecode(p).toString('utf8')),
    signature: s,
    signingInput: `${h}.${p}`,
  };
}

/** Join header and payload (and a signature segment, '' = unsigned) into a token. */
export function buildToken(header: Record<string, unknown>, payload: Record<string, unknown>, signature = ''): string {
  return `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(payload))}.${signature}`;
}

/** Timing-safe equality of two strings or buffers (different lengths are simply unequal). */
export function safeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The HMAC of `signingInput` as base64url. The key may be empty (a lab flaw may need that). */
export function hmacSignature(alg: HmacAlg, key: string | Uint8Array, signingInput: string): string {
  if (!isHmacAlg(alg)) throw new JwtFormatError('unsupported HMAC algorithm');
  return createHmac(HMAC_HASH[alg], key).update(signingInput).digest('base64url');
}

/** A complete HS* token: header `{ alg, typ: 'JWT', ...extraHeader }`. */
export function signHmac(
  alg: HmacAlg, key: string | Uint8Array, payload: Record<string, unknown>, extraHeader: Record<string, unknown> = {},
): string {
  const header = { alg, typ: 'JWT', ...extraHeader };
  const input = buildToken(header, payload).slice(0, -1);
  return `${input}.${hmacSignature(alg, key, input)}`;
}

/** RSASSA-PKCS1-v1_5 signature of `signingInput` as base64url. */
export function rsaSignature(alg: RsaAlg, privateKey: string | KeyObject, signingInput: string): string {
  if (!isRsaAlg(alg)) throw new JwtFormatError('unsupported RSA algorithm');
  return createSign(RSA_HASH[alg]).update(signingInput).sign(privateKey).toString('base64url');
}

/** Verify an RSASSA-PKCS1-v1_5 signature. A bad, mangled or empty signature is `false`, never a throw. */
export function rsaVerify(alg: RsaAlg, publicKey: string | KeyObject, signingInput: string, signature: string): boolean {
  if (!isRsaAlg(alg)) throw new JwtFormatError('unsupported RSA algorithm');
  if (typeof signature !== 'string' || signature === '') return false;
  let sigBytes: Buffer;
  try { sigBytes = b64urlDecode(signature); } catch { return false; }
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  if (key.asymmetricKeyType !== 'rsa') return false; // an EC/Ed25519 key is never an RSA verifier
  return createVerify(RSA_HASH[alg]).update(signingInput).verify(key, sigBytes);
}

/** A complete RS* token: header `{ alg, typ: 'JWT', ...extraHeader }`. */
export function signRsa(
  alg: RsaAlg, privateKey: string | KeyObject, payload: Record<string, unknown>, extraHeader: Record<string, unknown> = {},
): string {
  const header = { alg, typ: 'JWT', ...extraHeader };
  const input = buildToken(header, payload).slice(0, -1);
  return `${input}.${rsaSignature(alg, privateKey, input)}`;
}

/** A fresh RSA key pair as PEM text (SPKI public, PKCS#8 private). */
export function generateRsaKeyPair(modulusLength = 2048): { readonly publicPem: string; readonly privatePem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicPem: publicKey, privatePem: privateKey };
}
