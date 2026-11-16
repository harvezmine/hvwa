import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';
import { FLAG_RE, TEST_SECRET } from '../../../../tests/helpers.js';
import { setFlagSecret } from '../../../core/flags.js';
import { ADMIN_NAME, PLAYER, accountOf, accountsFor, flagLine, roleOf, sendAdminPage, welcome } from './lab.js';

// sendAdminPage renders through sendPage: capture what it is given instead of rendering a whole page.
const rendered = vi.hoisted(() => ({ data: undefined as Record<string, unknown> | undefined }));
vi.mock('../../../core/render.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/render.js')>()),
  sendPage: (_res: unknown, _view: string, data: Record<string, unknown>) => { rendered.data = data; return Promise.resolve(); },
}));
const fakeRes = () => {
  const res = { statusCode: 200, locals: { labPath: '/d/gatekeeper/x' }, status(n: number) { res.statusCode = n; return res; } };
  return res as unknown as Response & { statusCode: number };
};

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

  it('accountOf: the admin with this lab\'s password, pilgrim/pilgrim, nobody else', () => {
    expect(accountOf(ADMIN_NAME, 'pw', 'pw')).toBe(ADMIN_NAME);
    expect(accountOf('pilgrim', 'pilgrim', 'pw')).toBe('pilgrim');
    for (const [u, p] of [[ADMIN_NAME, 'pilgrim'], [ADMIN_NAME, ''], ['pilgrim', 'pw'], ['nobody', 'pw'], ['', '']]) {
      expect(accountOf(u, p, 'pw'), `${u}/${p}`).toBeUndefined();
    }
  });

  it('roleOf: the citadel admin is the admin, everyone else a user', () => {
    expect(roleOf(ADMIN_NAME)).toBe('admin');
    expect(roleOf('pilgrim')).toBe('user');
    expect(roleOf('CITADEL_ADMIN')).toBe('user');
  });

  it('welcome: a user never gets the flag, the admin does below Divine, Divine never', () => {
    expect(welcome(req('acolyte'), challenge, { username: 'pilgrim', role: 'user' }).text).not.toMatch(FLAG_RE);
    const admin = welcome(req('templar'), challenge, { username: ADMIN_NAME, role: 'admin' });
    expect(admin.ok).toBe(true);
    expect(admin.text).toMatch(FLAG_RE);
    const divine = welcome(req('divine'), challenge, { username: ADMIN_NAME, role: 'admin' });
    expect(divine).toEqual({ ok: true, text: 'Welcome, citadel_admin (role: admin).' });
  });

  it('flagLine: the flag below Divine, a plain welcome at Divine', () => {
    expect(flagLine(req('templar'), challenge)).toMatch(/^Flag: HVWA\{[0-9a-f]{32}\}$/);
    expect(flagLine(req('divine'), challenge)).toBe('Welcome back.');
  });

  it('sendAdminPage: the flag line only for a caller who got in; Divine never shows a flag even when the lab passes `flag`', async () => {
    const flag = (level: 'templar' | 'divine') => ({ req: req(level), challenge });
    const admin = async (level: 'templar' | 'divine', admin: boolean, withFlag: boolean) => {
      const res = fakeRes();
      await sendAdminPage(res, { admin, granted: 'Citadel admin console.', denial: 'Admin only.', ...(withFlag ? { flag: flag(level) } : {}) });
      return { text: String(rendered.data?.granted), status: res.statusCode };
    };
    expect((await admin('templar', true, true)).text).toMatch(/^Citadel admin console\. Flag: HVWA\{[0-9a-f]{32}\}$/);
    expect((await admin('templar', true, false)).text).toBe('Citadel admin console.');
    expect(await admin('divine', true, true)).toEqual({ text: 'Citadel admin console. Welcome back.', status: 200 });
    const denied = await admin('templar', false, true);
    expect(denied.status).toBe(403);
    expect(denied.text).not.toMatch(FLAG_RE);
    expect(String(rendered.data?.denial)).toBe('Admin only.');
  });

  it('sendAdminPage: 403 by default, `denyStatus` overrides', async () => {
    for (const [denyStatus, want] of [[undefined, 403], [200, 200], [401, 401]] as const) {
      const res = fakeRes();
      await sendAdminPage(res, { admin: false, granted: '', denial: 'no', ...(denyStatus === undefined ? {} : { denyStatus }) });
      expect(res.statusCode).toBe(want);
    }
  });
});
