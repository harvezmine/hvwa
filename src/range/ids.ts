// src/range/ids.ts — instance ids (spec range §5.2): 128-bit random, RFC 4648 base32 in lower case, 26 characters. The
// id is also the lab's host name: i-<id>.<domain>.
import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const INSTANCE_ID_RE = /^[a-z2-7]{26}$/;

/** RFC 4648 base32, lower case, no padding. */
export function base32(bytes: Uint8Array): string {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function newInstanceId(): string {
  return base32(randomBytes(16));
}
