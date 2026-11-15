// challenge.ts — GK-18 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field, labPath } from '../../../core/lab.js';
import { flagFor } from '../../../core/mount.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { PLAYER, type Result } from '../_shared/lab.js';
import { cookieName, labFor, type Identity, type RoleLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const labView = join(dir, 'views', 'lab.ejs');
const adminView = join(dir, 'views', 'admin.ejs');
const impl = byLevel<RoleLevel>({ acolyte, templar, inquisitor, divine });

/** The identity the request's lab cookie says it has (the level decides how much to trust it). */
function identityOf(req: Request): Identity | undefined {
  const cookie = (req.cookies as Record<string, unknown> | undefined)?.[cookieName(req.level)];
  return impl.for(req.level).read(labFor(req), cookie);
}

/** Identity shown on the page: bounded text (the cookie is client-written below Divine). */
const shown = (who: Identity | undefined) =>
  who === undefined ? null : { user: who.user.slice(0, 40), role: who.role.slice(0, 40) };

export const GK18 = register(defineChallenge({
  id: 'GK-18', district: 'gatekeeper', slug: 'role-cookie', dir,
  title: { id: 'Cookie Peran', en: 'Role Cookie' },
  summary: {
    id: 'Server memercayai cookie untuk tahu perannya. Jadikan dirimu admin tanpa sandi admin, lalu buka halaman admin.',
    en: 'The server trusts a cookie to know your role. Become the admin without the admin password, then open the admin page.',
  },
  maps: ['A01:2025', 'A04:2025', 'CWE-565', 'CWE-602'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Masuk, lalu lihat cookie yang diberikan. Siapa yang menyimpan nilai itu, dan siapa yang bisa mengubahnya?', en: 'Sign in, then look at the cookie you are given. Who holds that value, and who can change it?' } },
    { id: 2, cost: 20, text: { id: 'Kalau nilainya tampak seperti kode, apakah itu penyandian atau tanda tangan? Apa bedanya bagi orang yang ingin memalsukannya?', en: 'If the value looks like a code, is it an encoding or a signature? What difference does that make to someone forging it?' } },
    { id: 3, cost: 40, text: { id: 'Tanda tangan hanya melindungi apa yang ditandatangani. Bagian mana dari cookie yang sebenarnya tercakup?', en: 'A signature protects only what it signs. Which parts of the cookie does it really cover?' } },
  ],
  mount: (router) => {
    const page = async (req: Request, res: Response, result: Result | null, username: string, password: string) => {
      await sendPage(res, labView, {
        base: labPath(res), account: PLAYER, cookie: cookieName(req.level), httpOnly: impl.for(req.level).httpOnly,
        who: shown(identityOf(req)), result, username, password,
      });
    };

    router.get('/', async (req, res) => { await page(req, res, null, '', ''); });

    router.post('/', async (req, res) => {
      const username = field(req, 'username');
      const password = field(req, 'password');
      let result: Result;
      if (username === PLAYER.username && password === PLAYER.password) {
        const level = impl.for(req.level);
        const value = level.issue(labFor(req), { user: PLAYER.username, role: 'user' });
        res.cookie(cookieName(req.level), value, { path: labPath(res), httpOnly: level.httpOnly, sameSite: 'lax' });
        result = { ok: true, text: `Signed in as ${PLAYER.username}.` };
      } else {
        result = { ok: false, text: 'Invalid username or password.' };
      }
      await page(req, res, result, username, password);
    });

    router.get('/admin', async (req, res) => {
      const admin = identityOf(req)?.role === 'admin';
      // Only a request whose cookie claims admin sees the flag, and Divine never issues one.
      const note = !admin ? '' : req.level === 'divine' ? 'Welcome back.' : `Flag: ${flagFor(req, GK18)}`;
      await sendPage(res, adminView, { base: labPath(res), admin, note });
    });
  },
}));
