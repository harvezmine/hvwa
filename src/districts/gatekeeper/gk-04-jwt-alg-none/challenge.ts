// challenge.ts — GK-04 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field, header, labPath } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { PLAYER, welcome, type Result } from '../_shared/lab.js';
import { cookieName, issueToken, labFor, type JwtLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'portal.ejs');
const impl = byLevel<JwtLevel>({ acolyte, templar, inquisitor, divine });

/** The lab cookie's value, if it is a string. */
function cookieOf(req: Request): string | undefined {
  const v = (req.cookies as Record<string, unknown> | undefined)?.[cookieName(req.level)];
  return typeof v === 'string' ? v : undefined;
}

/** The presented token: `Authorization: Bearer <jwt>` first, else the lab cookie. */
function presented(req: Request): string | undefined {
  const auth = header(req, 'authorization');
  if (auth !== undefined) return /^Bearer\s+(\S+)\s*$/i.exec(auth)?.[1];
  return cookieOf(req);
}

export const GK04 = register(defineChallenge({
  id: 'GK-04', district: 'gatekeeper', slug: 'jwt-alg-none', dir,
  title: { id: 'JWT: alg none', en: 'JWT: alg none' },
  summary: {
    id: 'Brankas Citadel hanya terbuka untuk admin. Palsukan token JWT-mu agar server tidak memeriksa tanda tangannya.',
    en: 'The citadel vault opens only for the admin. Forge a JWT so the server never checks its signature.',
  },
  maps: ['A07:2025', 'CWE-347'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Bongkar tokenmu: bagian pertama menyebut sesuatu tentang cara tanda tangan diperiksa. Siapa yang memutuskan cara itu, server atau pengirim?', en: 'Take your token apart: the first part says something about how the signature is checked. Who decides that, the server or the sender?' } },
    { id: 2, cost: 20, text: { id: 'Kalau satu nilai di header ditolak, tanyakan: bagaimana server membandingkannya, dan bagaimana ia memperlakukan huruf besar-kecil?', en: 'If one header value is refused, ask how the server compares it, and how it treats upper and lower case.' } },
    { id: 3, cost: 40, text: { id: 'Kalau semua ejaan ditolak, apa yang terjadi bila bagian ketiga token tidak berisi apa-apa? Apakah "kosong" sama dengan "salah"?', en: 'If every spelling is refused, what happens when the third part of the token holds nothing at all? Is "empty" treated like "wrong"?' } },
  ],
  mount: (router) => {
    const data = (req: Request, res: Response, token: string, result: Result | null, username: string, password: string) =>
      ({ base: labPath(res), cookie: cookieName(req.level), account: PLAYER, token, result, username, password });

    router.get('/', async (req, res) => {
      await sendPage(res, view, data(req, res, cookieOf(req) ?? '', null, '', ''));
    });

    router.post('/', async (req, res) => {
      const username = field(req, 'username');
      const password = field(req, 'password');
      let result: Result;
      let token = cookieOf(req) ?? '';
      if (username === PLAYER.username && password === PLAYER.password) {
        token = issueToken(labFor(req), { sub: PLAYER.username, role: 'user' });
        // Not HttpOnly on purpose: the player is meant to edit it (the page says how).
        res.cookie(cookieName(req.level), token, { path: labPath(res), httpOnly: false, sameSite: 'lax' });
        result = { ok: true, text: `Signed in as ${PLAYER.username}. Token issued.` };
      } else {
        result = { ok: false, text: 'Invalid username or password.' };
      }
      await sendPage(res, view, data(req, res, token, result, username, password));
    });

    router.get('/vault', async (req, res) => {
      const token = presented(req);
      let result: Result;
      if (token === undefined || token === '') {
        result = { ok: false, text: 'Missing token. Sign in first, then send it as a Bearer header or the lab cookie.' };
      } else {
        const verdict = impl.for(req.level).verify(labFor(req), token);
        if (!verdict.ok) {
          // Below Divine the reason is shown on purpose (CWE-209); Divine only says it was refused.
          result = { ok: false, text: req.level === 'divine' ? 'Invalid token.' : `Invalid token: ${verdict.reason}.` };
        } else {
          const sub = verdict.claims.sub;
          const role = verdict.claims.role;
          // The flag needs a VERIFIED role "admin"; Divine never issues one (welcome() enforces it).
          result = welcome(req, GK04, { username: typeof sub === 'string' ? sub : 'unknown', role: typeof role === 'string' ? role : 'unknown' });
        }
      }
      await sendPage(res, view, data(req, res, cookieOf(req) ?? '', result, '', ''));
    });
  },
}));
