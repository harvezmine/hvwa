import { describe, it, expect } from 'vitest';
import { t, translationKeys } from '../src/core/i18n.js';

describe('i18n', () => {
  it('returns different strings per language and echoes unknown keys', () => {
    expect(t('nav.districts', 'id')).not.toBe(t('nav.districts', 'en'));
    expect(t('nav.districts', 'id')).toBe('Distrik');
    expect(t('nav.districts', 'en')).toBe('Districts');
    expect(t('this.key.does.not.exist', 'en')).toBe('this.key.does.not.exist');
  });

  it('both safety banners warn against UNtrusted networks', () => {
    expect(t('safety.warning', 'en')).toMatch(/never expose it to an untrusted network/i);
    expect(t('safety.warning', 'id')).toMatch(/jangan pernah mengeksposnya ke jaringan yang tidak tepercaya/i);
  });

  it('the portal banner does not claim to run offline (the standalone one still does)', () => {
    expect(t('app.footer', 'en')).toContain('offline');
    expect(t('app.footer', 'id')).toContain('offline');
    expect(t('safety.portal', 'en')).not.toMatch(/offline|nothing is sent|never expose/i);
    expect(t('safety.portal', 'id')).not.toMatch(/offline|tidak ada permintaan|jangan pernah mengekspos/i);
    for (const [key, lang] of [['safety.portal', 'en'], ['safety.portal', 'id']] as const) {
      expect(t(key, lang).length, `${key}/${lang}`).toBeGreaterThan(20);
    }
  });

  it('every range.* key is really translated in Indonesian (no English copy left behind)', () => {
    const keys = translationKeys().filter((k) => k.startsWith('range.'));
    expect(keys.length).toBeGreaterThan(30);
    const untranslated = keys.filter((k) => t(k, 'id') === t(k, 'en'));
    expect(untranslated).toEqual([]);
  });

  it('the simulated-victim panel keys follow the underscore convention (no hyphenated keys)', () => {
    for (const key of ['sim.outcome.too_many_redirects', 'sim.reason.too_long']) {
      expect(t(key, 'en'), key).not.toBe(key);
      expect(t(key, 'id'), key).not.toBe(key);
    }
    for (const key of ['sim.outcome.too-many-redirects', 'sim.reason.too-long']) expect(t(key, 'en'), key).toBe(key);
  });

  it.each(['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf'])(
    'treats inherited Object property %j as an unknown key', (key) => {
      expect(t(key, 'en')).toBe(key);
      expect(t(key, 'id')).toBe(key);
    });
});
