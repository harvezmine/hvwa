// labs/r06-camelot/app/court.mjs — every secret the court keeps, and the one weak spell per level (spec §6: the level
// is the only thing that changes). Keys, the true words and the dream are minted once per start, held in memory, never
// logged and never rendered. Three surfaces, one level weak at a time:
//   - the dream scroll (GET /dream):    Acolyte  repeating-key XOR, 12-byte key ("twelve knights take turns")
//                                       Inquisitor AES-128-CBC behind Merlin's padding oracle
//                                       others   AES-256-GCM (authenticated, unreadable without the key)
//   - the petition seal (POST /petition): Templar AES-128-ECB over `petitioner=<name>;rank=peasant` (cut-and-paste)
//                                       others   AES-256-GCM (any tamper fails authentication)
//   - Merlin (POST /oracle):            Inquisitor says "clear"/"clouded" for valid/invalid CBC padding
//                                       others   says "clear" only for an authentic GCM scroll — it leaks nothing
// The stone (POST /stone) accepts either proof at every level: the true words, or a seal whose rank is `knight`.
// Divine is the same app with every surface on GCM: the secure reference.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const XOR_KEY_LENGTH = 12;
export const MAX_NAME = 64;

const sha = (s) => createHash('sha256').update(s).digest();

/** The words a petitioner speaks at the stone, normalised the same way on both sides. */
export const normaliseWords = (s) => String(s).toLowerCase().trim().split(/[\s,;-]+/).filter(Boolean).join('-');

/** A petitioner name the seal will carry: 1..64 characters, 0x01..0x7e, no field separators (`;` and `=`). */
export function validName(name) {
  if (typeof name !== 'string' || name.length < 1 || name.length > MAX_NAME) return false;
  for (const ch of name) {
    const c = ch.codePointAt(0);
    if (c < 0x01 || c > 0x7e || ch === ';' || ch === '=') return false;
  }
  return true;
}

/** Parse a decrypted seal (`k=v;k=v`); the last value of a repeated key wins. */
export function parseSeal(text) {
  const fields = new Map();
  for (const part of text.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) fields.set(part.slice(0, i), part.slice(i + 1));
  }
  return fields;
}

const hexOk = (h, max) => typeof h === 'string' && h.length > 0 && h.length <= max && h.length % 2 === 0 && /^[0-9a-f]+$/i.test(h);

export function createCourt(level, seed) {
  const xorKey = randomBytes(XOR_KEY_LENGTH);
  const blockKey = randomBytes(16); // ECB (Templar seals) and CBC (Inquisitor dream)
  const gcmKey = randomBytes(32);
  const words = Array.from({ length: 3 }, () => seed.words[randomInt(seed.words.length)]).join('-');
  const wordsDigest = sha(words);
  const dream = Buffer.from(seed.dream.replace('{words}', words), 'utf8');

  const gcmSeal = (plain) => {
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', gcmKey, nonce);
    const body = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([nonce, body, c.getAuthTag()]);
  };
  const gcmOpen = (buf) => {
    if (buf.length < 12 + 16 + 1) return undefined;
    try {
      const d = createDecipheriv('aes-256-gcm', gcmKey, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(buf.length - 16));
      return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
    } catch { return undefined; }
  };
  const ecbSeal = (plain) => {
    const c = createCipheriv('aes-128-ecb', blockKey, null);
    return Buffer.concat([c.update(plain), c.final()]);
  };
  const ecbOpen = (buf) => {
    if (buf.length === 0 || buf.length % 16 !== 0) return undefined;
    try {
      const d = createDecipheriv('aes-128-ecb', blockKey, null);
      return Buffer.concat([d.update(buf), d.final()]);
    } catch { return undefined; }
  };
  const cbcSeal = (plain) => {
    const iv = randomBytes(16);
    const c = createCipheriv('aes-128-cbc', blockKey, iv);
    return Buffer.concat([iv, c.update(plain), c.final()]);
  };
  /** The padding oracle: true iff the CBC padding is valid. The plaintext itself never leaves this function. */
  const cbcPaddingOk = (buf) => {
    if (buf.length < 32 || buf.length % 16 !== 0) return false;
    try {
      const d = createDecipheriv('aes-128-cbc', blockKey, buf.subarray(0, 16));
      d.update(buf.subarray(16));
      d.final();
      return true;
    } catch { return false; }
  };

  const dreamScroll = (() => {
    if (level === 'acolyte') return Buffer.from(dream.map((b, i) => b ^ xorKey[i % XOR_KEY_LENGTH]));
    if (level === 'inquisitor') return cbcSeal(dream);
    return gcmSeal(dream);
  })().toString('hex');

  return {
    level,
    /** The king's sealed dream, hex. Fixed for the life of the instance. */
    dreamScroll: () => dreamScroll,

    /** A petition seal (hex) for `name`, or undefined for an invalid name. */
    petition(name) {
      if (!validName(name)) return undefined;
      const plain = Buffer.from(`petitioner=${name};rank=peasant`, 'latin1');
      return (level === 'templar' ? ecbSeal(plain) : gcmSeal(plain)).toString('hex');
    },

    /** Read a seal back: { petitioner, rank } or undefined when it does not open. */
    readSeal(hex) {
      if (!hexOk(hex, 1024)) return undefined;
      const buf = Buffer.from(hex, 'hex');
      const plain = level === 'templar' ? ecbOpen(buf) : gcmOpen(buf);
      if (!plain) return undefined;
      const fields = parseSeal(plain.toString('latin1'));
      return { petitioner: fields.get('petitioner') ?? '', rank: fields.get('rank') ?? '' };
    },

    /** Merlin's verdict on one scroll: 'clear' or 'clouded'. */
    consult(hex) {
      if (!hexOk(hex, 2048)) return 'clouded';
      const buf = Buffer.from(hex, 'hex');
      if (level === 'inquisitor') return cbcPaddingOk(buf) ? 'clear' : 'clouded';
      return gcmOpen(buf) ? 'clear' : 'clouded';
    },

    /** True iff `spoken` are the true words (normalised, constant-time over digests). */
    wordsMatch(spoken) {
      if (typeof spoken !== 'string' || spoken.length > 128) return false;
      return timingSafeEqual(sha(normaliseWords(spoken)), wordsDigest);
    },
  };
}
