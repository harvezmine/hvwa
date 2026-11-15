import { describe, it, expect } from 'vitest';
import {
  LEVELS, FLAG_LEVELS, LEVEL_MULTIPLIER, levelRank, isLevel, pointsForLevel, clampLevel,
} from '../src/core/levels.js';
import { LANGS, isLang } from '../src/core/i18n.js';

describe('levels (single source)', () => {
  it('LEVELS is the frozen rank order', () => {
    expect(LEVELS).toEqual(['acolyte', 'templar', 'inquisitor', 'divine']);
    expect(Object.isFrozen(LEVELS)).toBe(true);
    expect(LEVELS.map(levelRank)).toEqual([0, 1, 2, 3]);
  });

  it('FLAG_LEVELS are the exploitable (non-Divine) levels, frozen', () => {
    expect(FLAG_LEVELS).toEqual(['acolyte', 'templar', 'inquisitor']);
    expect(Object.isFrozen(FLAG_LEVELS)).toBe(true);
  });

  it('multipliers are frozen and Divine scores 0', () => {
    expect(LEVEL_MULTIPLIER).toEqual({ acolyte: 1, templar: 1.5, inquisitor: 2, divine: 0 });
    expect(Object.isFrozen(LEVEL_MULTIPLIER)).toBe(true);
    expect(pointsForLevel(100, 'templar')).toBe(150);
    expect(pointsForLevel(100, 'divine')).toBe(0);
  });

  it('isLevel accepts only the four levels', () => {
    for (const l of LEVELS) expect(isLevel(l)).toBe(true);
    for (const x of ['god', 'Acolyte', '', 'toString', 1, null, undefined, ['acolyte']]) {
      expect(isLevel(x)).toBe(false);
    }
  });
});

describe('clampLevel', () => {
  const impl = ['acolyte', 'inquisitor', 'divine'] as const;

  it('keeps an implemented requested level', () => {
    expect(clampLevel('inquisitor', impl)).toBe('inquisitor');
    expect(clampLevel('divine', impl)).toBe('divine');
  });

  it('falls to the highest implemented level ranked at or below the request', () => {
    expect(clampLevel('templar', impl)).toBe('acolyte');
  });

  it('uses the lowest implemented level when nothing is at or below the request', () => {
    expect(clampLevel('acolyte', ['templar', 'divine'])).toBe('templar');
    expect(clampLevel('templar', ['divine', 'inquisitor'])).toBe('inquisitor');
  });

  it('ignores the order the implemented levels are listed in', () => {
    expect(clampLevel('templar', ['divine', 'inquisitor', 'acolyte'])).toBe('acolyte');
  });
});

describe('langs', () => {
  it('LANGS is frozen and isLang uses it', () => {
    expect(LANGS).toEqual(['id', 'en']);
    expect(Object.isFrozen(LANGS)).toBe(true);
    expect(isLang('id')).toBe(true);
    expect(isLang('en')).toBe(true);
    for (const x of ['fr', 'EN', 'toString', '', 0]) expect(isLang(x)).toBe(false);
  });
});
