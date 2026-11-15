// challenge.ts — GK-05 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
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

export const GK05 = register(defineChallenge({
  id: 'GK-05', district: 'gatekeeper', slug: 'jwt-key-confusion', dir,
  title: { id: 'JWT: Kebingungan Kunci', en: 'JWT: Key Confusion' },
  summary: {
    id: 'Token JWT diverifikasi dengan kunci publik citadel. Buat server memakai kunci yang salah, lalu buka brankas sebagai admin.',
    en: 'JWTs are verified with the citadel public key. Make the server use the wrong key, then open the vault as admin.',
  },
  maps: ['A07:2025', 'CWE-347', 'CWE-327'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Kunci publik itu memang untuk dibagikan. Tanyakan: algoritma apa yang bisa memakai teks kunci itu, dan siapa yang memilih algoritmanya?', en: 'A public key is meant to be shared. Ask which kind of algorithm could use that very text, and who chooses the algorithm.' } },
    { id: 2, cost: 20, text: { id: 'Kalau satu nama algoritma diblokir, tanyakan apakah daftar hitam itu menutup seluruh keluarganya atau hanya satu anggotanya.', en: 'If one algorithm name is blocked, ask whether the blacklist covers the whole family or just one member.' } },
    { id: 3, cost: 40, text: { id: 'Kalau hanya keluarga RS yang diterima, dari mana server mengambil kunci untuk memeriksa? Adakah bagian token yang menawarkan kuncinya sendiri?', en: 'If only the RS family is accepted, where does the server get the key to check with? Does any part of the token offer its own?' } },
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

    // The public key, published as exactly the text the verifier holds (an attacker needs the exact bytes).
    router.get('/public.pem', (req, res) => { res.type('text/plain').send(labFor(req).publicPem); });

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
          result = welcome(req, GK05, { username: typeof sub === 'string' ? sub : 'unknown', role: typeof role === 'string' ? role : 'unknown' });
        }
      }
      await sendPage(res, view, data(req, res, cookieOf(req) ?? '', result, '', ''));
    });
  },
}));
