// challenge.ts — GK-06 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import type { Level } from '../../../core/levels.js';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field, header, labPath, tryDb } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { PLAYER, welcome, type Result } from '../_shared/lab.js';
import { signHmac } from '../_shared/jwt.js';
import { ROBOTS_TXT, cookieName, labFor, labState, type Claims, type JwtLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'portal.ejs');
const impl = byLevel<JwtLevel>({ acolyte, templar, inquisitor, divine });

/** Sign claims the way the genuine server does: HS256 with the lab's key, naming the key by this level's kid. */
function issueToken(req: Pick<Request, 'sessionId' | 'level'>, claims: Claims): string {
  const state = labFor(req);
  return signHmac('HS256', state.signingKey, { ...claims, iat: Math.floor(state.now() / 1000) }, { kid: impl.for(req.level).kid });
}

/** Test seam: a genuine token (signed by the real server key) for any claims. */
export function mintToken(sessionId: string, level: Level, claims: Claims): string {
  labState(sessionId, level); // the lab exists
  return issueToken({ sessionId, level }, claims);
}

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

export const GK06 = register(defineChallenge({
  id: 'GK-06', district: 'gatekeeper', slug: 'jwt-kid-injection', dir,
  title: { id: 'JWT: Injeksi kid', en: 'JWT: kid Injection' },
  summary: {
    id: 'Server mencari kunci tanda tangan lewat kolom kid di header token. Arahkan pencarian itu ke kunci yang kamu kenal, lalu buka brankas sebagai admin.',
    en: 'The server finds the signing key through the kid field in the token header. Steer that lookup to a key you know, then open the vault as admin.',
  },
  maps: ['A07:2025', 'CWE-22', 'CWE-89'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Bongkar tokenmu: header menyebut kunci mana yang dipakai. Siapa yang mengisi nilai itu, dan ke mana server membawanya?', en: 'Take your token apart: the header names the key to use. Who fills in that value, and where does the server take it?' } },
    { id: 2, cost: 20, text: { id: 'Kalau nilai itu dipakai sebagai nama berkas, tanyakan apa yang berhenti di batas folder kunci, dan apakah penyaring yang menghapus sesuatu cukup kalau hanya dijalankan sekali. Berkas apa yang isinya kamu ketahui?', en: 'If the value is used as a file name, ask what stops it at the key folder, and whether a filter that removes something is enough when it runs only once. Which files have contents you already know?' } },
    { id: 3, cost: 40, text: { id: 'Kalau tidak ada lagi berkas, di mana kunci disimpan? Apa yang terjadi pada pencarian bila nilai kid berisi tanda kutip, dan bisakah pencarian itu mengembalikan baris yang kamu tulis sendiri?', en: 'If there are no files any more, where are the keys kept? What happens to the lookup when the kid contains a quote, and can that lookup return a row you wrote yourself?' } },
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
        token = issueToken(req, { sub: PLAYER.username, role: 'user' });
        // Not HttpOnly on purpose: the player is meant to edit it (the page says how).
        res.cookie(cookieName(req.level), token, { path: labPath(res), httpOnly: false, sameSite: 'lax' });
        result = { ok: true, text: `Signed in as ${PLAYER.username}. Token issued.` };
      } else {
        result = { ok: false, text: 'Invalid username or password.' };
      }
      await sendPage(res, view, data(req, res, token, result, username, password));
    });

    // The archive's public web root: a file whose contents everyone knows (it is also /srv/www/robots.txt).
    router.get('/robots.txt', (_req, res) => { res.type('text/plain').send(ROBOTS_TXT); });

    router.get('/vault', async (req, res) => {
      const token = presented(req);
      let result: Result;
      if (token === undefined || token === '') {
        result = { ok: false, text: 'Missing token. Sign in first, then send it as a Bearer header or the lab cookie.' };
      } else {
        const verdict = impl.for(req.level).verify(labFor(req), token, (fn) => tryDb(req, fn));
        if (!verdict.ok) {
          // Below Divine the reason is shown on purpose (CWE-209); Divine only says it was refused.
          result = { ok: false, text: req.level === 'divine' ? 'Invalid token.' : `Invalid token: ${verdict.reason}.` };
        } else {
          const sub = verdict.claims.sub;
          const role = verdict.claims.role;
          // The flag needs a VERIFIED role "admin"; Divine never issues one (welcome() enforces it).
          result = welcome(req, GK06, { username: typeof sub === 'string' ? sub : 'unknown', role: typeof role === 'string' ? role : 'unknown' });
        }
      }
      await sendPage(res, view, data(req, res, cookieOf(req) ?? '', result, '', ''));
    });
  },
}));
