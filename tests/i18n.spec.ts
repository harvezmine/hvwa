import { describe, it, expect } from 'vitest';
import { t } from '../src/core/i18n.js';

describe('i18n', () => {
  it('returns different strings per language and echoes unknown keys', () => {
    expect(t('nav.districts', 'id')).not.toBe(t('nav.districts', 'en'));
    expect(t('nav.districts', 'id')).toBe('Distrik');
    expect(t('nav.districts', 'en')).toBe('Districts');
    expect(t('this.key.does.not.exist', 'en')).toBe('this.key.does.not.exist');
  });
});
