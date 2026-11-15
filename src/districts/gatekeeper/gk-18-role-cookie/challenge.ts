// challenge.ts — GK-18 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, labPath } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { PLAYER, curlFor, pilgrimLogin, sendAdminPage, type Result } from '../_shared/lab.js';
import { cookieName, labFor, type Identity, type RoleLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const labView = join(dir, 'views', 'lab.ejs');
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
  maps: ['A01:2025', 'A08:2025', 'CWE-565', 'CWE-602'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Masuk, lalu baca nilai cookie itu. Apakah itu tampak seperti sesuatu yang hanya bisa dibuat server?', en: 'Sign in, then read the value of the cookie. Does it look like something only the server could have made?' } },
    { id: 2, cost: 20, text: { id: 'Kalau nilainya tampak seperti kode, apakah itu penyandian atau tanda tangan? Apa bedanya bagi orang yang ingin memalsukannya?', en: 'If the value looks like a code, is it an encoding or a signature? What difference does that make to someone forging it?' } },
    { id: 3, cost: 40, text: { id: 'Kalau sebuah nilai ditandatangani, tanyakan apa persisnya yang masuk ke tanda tangan itu, dan apakah server kemudian mempercayai sesuatu yang tidak ikut ditandatangani.', en: 'When a value is signed, ask what exactly went into the signature, and whether the server later trusts something that was not in it.' } },
  ],
  mount: (router) => {
    const page = async (req: Request, res: Response, result: Result | null, username: string, password: string) => {
      await sendPage(res, labView, {
        base: labPath(res), account: PLAYER, cookie: cookieName(req.level), curl: curlFor(req, res, { path: '/admin', cookies: [`${cookieName(req.level)}=<cookie value>`] }), httpOnly: impl.for(req.level).httpOnly,
        who: shown(identityOf(req)), result, username, password,
      });
    };

    router.get('/', async (req, res) => { await page(req, res, null, '', ''); });

    router.post('/', async (req, res) => {
      const login = pilgrimLogin(req);
      if (login.ok) {
        const level = impl.for(req.level);
        const value = level.issue(labFor(req), { user: PLAYER.username, role: 'user' });
        res.cookie(cookieName(req.level), value, { path: labPath(res), httpOnly: level.httpOnly, sameSite: 'lax' });
      }
      await page(req, res, login.result, login.username, login.password);
    });

    router.get('/admin', async (req, res) => {
      const admin = identityOf(req)?.role === 'admin';
      // Only a request whose cookie claims admin sees the flag, and Divine never issues one.
      await sendAdminPage(res, {
        admin, granted: 'Citadel admin console.', flag: { req, challenge: GK18 },
        denial: 'Admin only. Your cookie does not say you are the citadel admin.',
      });
    });
  },
}));
