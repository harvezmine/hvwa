// Instance ids and range flags (src/range/ids.ts, src/range/flags.ts, spec range §5.2 and §6), and the range key
// (src/core/secrets.ts resolveRangeKey): the flag is a MAC of (instance, lab, level) under a key only the portal holds.
import { describe, it, expect, afterEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base32, INSTANCE_ID_RE, newInstanceId } from '../src/range/ids.js';
import { flagHash, RANGE_FLAG_RE, rangeFlag } from '../src/range/flags.js';
import { MIN_RANGE_KEY_LENGTH, resolveRangeKey } from '../src/core/secrets.js';

const KEY = 'k'.repeat(40);
const ID = 'abcdefghijklmnopqrstuvwxyz';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('instance ids', () => {
  it('base32 follows RFC 4648 section 10 (lower case, no padding)', () => {
    expect(['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar'].map((s) => base32(Buffer.from(s))))
      .toEqual(['', 'my', 'mzxq', 'mzxw6', 'mzxw6yq', 'mzxw6ytb', 'mzxw6ytboi']);
  });

  it('newInstanceId: 26 characters of [a-z2-7] (128 bits); 1000 draws never repeat', () => {
    const ids = Array.from({ length: 1000 }, newInstanceId);
    for (const id of ids) expect(id).toMatch(INSTANCE_ID_RE);
    expect(new Set(ids).size).toBe(1000);
  });
});

describe('rangeFlag', () => {
  it('is HVWA{ + base32(HMAC-SHA256(rangeKey, "flag|" + id + "|" + lab + "|" + level))[:26] + }', () => {
    const mac = createHmac('sha256', KEY).update(`flag|${ID}|r01|templar`).digest();
    expect(rangeFlag(KEY, ID, 'r01', 'templar')).toBe(`HVWA{${base32(mac).slice(0, 26)}}`);
    expect(rangeFlag(KEY, ID, 'r01', 'templar')).toMatch(RANGE_FLAG_RE);
  });

  it('differs per instance, lab, level and key; Divine has none', () => {
    const flags = new Set([
      rangeFlag(KEY, ID, 'r01', 'acolyte'), rangeFlag(KEY, 'z'.repeat(26), 'r01', 'acolyte'),
      rangeFlag(KEY, ID, 'r02', 'acolyte'), rangeFlag(KEY, ID, 'r01', 'templar'), rangeFlag('q'.repeat(40), ID, 'r01', 'acolyte'),
    ]);
    expect(flags.size).toBe(5);
    expect(() => rangeFlag(KEY, ID, 'r01', 'divine')).toThrow(/Divine/);
  });

  it('flagHash is the hex SHA-256 (what an instance record keeps)', () => {
    const flag = rangeFlag(KEY, ID, 'r01', 'acolyte');
    expect(flagHash(flag)).toBe(createHash('sha256').update(flag).digest('hex'));
  });
});

describe('resolveRangeKey', () => {
  const temp = () => { const d = mkdtempSync(join(tmpdir(), 'hvwa-rk-')); dirs.push(d); return d; };

  it('HVWA_RANGE_KEY wins; a short one is an error', () => {
    expect(resolveRangeKey(temp(), ` ${KEY} `)).toBe(KEY);
    expect(() => resolveRangeKey(temp(), 'short')).toThrow(new RegExp(`${MIN_RANGE_KEY_LENGTH} characters`));
  });

  it('otherwise creates <data>/range-key once (64 hex) and reuses it; a short stored key is regenerated with a warning', () => {
    const dir = temp();
    const first = resolveRangeKey(dir, undefined);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(dir, 'range-key'), 'utf8').trim()).toBe(first);
    expect(resolveRangeKey(dir, '')).toBe(first);
    writeFileSync(join(dir, 'range-key'), 'tiny\n');
    const warnings: string[] = [];
    const again = resolveRangeKey(dir, undefined, (m) => warnings.push(m));
    expect(again).not.toBe('tiny');
    expect(warnings).toHaveLength(1);
    expect(existsSync(join(dir, 'range-key'))).toBe(true);
  });
});
