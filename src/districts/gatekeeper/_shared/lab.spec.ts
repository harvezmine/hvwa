import { describe, it, expect } from 'vitest';
import { FLAG_RE, TEST_SECRET } from '../../../../tests/helpers.js';
import { setFlagSecret } from '../../../core/flags.js';
import { ADMIN_NAME, PLAYER, accountsFor, adminNote, welcome } from './lab.js';

const challenge = { id: 'GK-99', levels: ['acolyte', 'templar', 'divine'] as const };
const req = (level: 'acolyte' | 'templar' | 'divine') => ({ sessionId: '11111111-1111-4111-8111-111111111111', level });

describe('gatekeeper _shared', () => {
  setFlagSecret(TEST_SECRET);

  it('accountsFor gives the admin the password and the player their own', () => {
    expect(accountsFor('pw')).toEqual([
      { username: ADMIN_NAME, password: 'pw', role: 'admin' },
      { username: PLAYER.username, password: PLAYER.password, role: 'user' },
    ]);
  });

  it('welcome: a user never gets the flag, the admin does below Divine, Divine never', () => {
    expect(welcome(req('acolyte'), challenge, { username: 'pilgrim', role: 'user' }).text).not.toMatch(FLAG_RE);
    const admin = welcome(req('templar'), challenge, { username: ADMIN_NAME, role: 'admin' });
    expect(admin.ok).toBe(true);
    expect(admin.text).toMatch(FLAG_RE);
    const divine = welcome(req('divine'), challenge, { username: ADMIN_NAME, role: 'admin' });
    expect(divine).toEqual({ ok: true, text: 'Welcome, citadel_admin (role: admin).' });
  });

  it('adminNote: nothing for a non-admin, the flag below Divine, a plain welcome at Divine', () => {
    expect(adminNote(req('acolyte'), challenge, false)).toBe('');
    expect(adminNote(req('divine'), challenge, false)).toBe('');
    expect(adminNote(req('templar'), challenge, true)).toMatch(/^Flag: HVWA\{[0-9a-f]{32}\}$/);
    expect(adminNote(req('divine'), challenge, true)).toBe('Welcome back.');
  });
});
