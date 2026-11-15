import { describe, it, expect, beforeAll } from 'vitest';
import { issueFlag, verifyFlag, setFlagSecret, MIN_FLAG_SECRET_LENGTH } from '../src/core/flags.js';
import { TEST_SECRET } from './helpers.js';

describe('flags', () => {
  beforeAll(() => setFlagSecret(TEST_SECRET));

  it('is deterministic per (challenge, session, level) and rejects cross-session flags', () => {
    const a = issueFlag('GK-01', 'sessA', 'acolyte');
    expect(a).toMatch(/^HVWA\{[0-9a-f]{32}\}$/);
    expect(issueFlag('GK-01', 'sessA', 'acolyte')).toBe(a);
    expect(verifyFlag('GK-01', 'sessA', 'acolyte', a)).toBe(true);
    expect(verifyFlag('GK-01', 'sessA', 'acolyte', `  ${a}\n`)).toBe(true);
    expect(verifyFlag('GK-01', 'sessB', 'acolyte', a)).toBe(false);
    expect(verifyFlag('GK-02', 'sessA', 'acolyte', a)).toBe(false);
  });

  it('issues a distinct flag per exploitable level and never cross-credits', () => {
    const acolyte = issueFlag('GK-01', 'sessA', 'acolyte');
    const templar = issueFlag('GK-01', 'sessA', 'templar');
    const inquisitor = issueFlag('GK-01', 'sessA', 'inquisitor');
    expect(new Set([acolyte, templar, inquisitor]).size).toBe(3);
    expect(verifyFlag('GK-01', 'sessA', 'inquisitor', acolyte)).toBe(false);
    expect(verifyFlag('GK-01', 'sessA', 'templar', acolyte)).toBe(false);
    expect(verifyFlag('GK-01', 'sessA', 'inquisitor', inquisitor)).toBe(true);
  });

  it('Divine never issues a flag and never verifies one', () => {
    expect(() => issueFlag('GK-01', 'sessA', 'divine')).toThrow(/divine/i);
    expect(verifyFlag('GK-01', 'sessA', 'divine', issueFlag('GK-01', 'sessA', 'acolyte'))).toBe(false);
  });

  it.each(['', 'short', '0123456789abcde', '                '])(
    'setFlagSecret rejects %j (fewer than 16 non-blank characters)', (s) => {
      expect(() => setFlagSecret(s)).toThrow(/at least 16/);
    });

  it('setFlagSecret accepts exactly 16 characters', () => {
    try {
      expect(() => setFlagSecret('0123456789abcdef')).not.toThrow();
    } finally {
      setFlagSecret(TEST_SECRET);
    }
  });

  it('MIN_FLAG_SECRET_LENGTH is 16 and is what config enforces', async () => {
    expect(MIN_FLAG_SECRET_LENGTH).toBe(16);
    const { parseConfig } = await import('../src/config.js');
    expect(() => parseConfig({ FLAG_SECRET: 'x'.repeat(MIN_FLAG_SECRET_LENGTH - 1) })).toThrow();
    expect(() => parseConfig({ FLAG_SECRET: 'x'.repeat(MIN_FLAG_SECRET_LENGTH) })).not.toThrow();
  });

  it('depends on the configured secret', () => {
    const a = issueFlag('GK-01', 'sessA', 'acolyte');
    setFlagSecret('another-secret-value');
    try {
      expect(issueFlag('GK-01', 'sessA', 'acolyte')).not.toBe(a);
    } finally {
      setFlagSecret(TEST_SECRET); // restore even if the assertion fails
    }
  });
});
