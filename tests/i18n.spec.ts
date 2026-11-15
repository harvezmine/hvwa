import { describe, it, expect } from 'vitest';
import { t } from '../src/core/i18n.js';

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

  it.each(['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf'])(
    'treats inherited Object property %j as an unknown key', (key) => {
      expect(t(key, 'en')).toBe(key);
      expect(t(key, 'id')).toBe(key);
    });
});
