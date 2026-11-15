// challenge.ts — GK-07 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { field, header, labPath, sendLines } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { PLAYER, welcome, type Result } from '../_shared/lab.js';
import { cookieName, impl, issueToken, labFor, wordlist } from './model.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'portal.ejs');

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

export const GK07 = register(defineChallenge({
  id: 'GK-07', district: 'gatekeeper', slug: 'jwt-weak-secret', dir,
  title: { id: 'JWT: Rahasia Lemah', en: 'JWT: Weak Secret' },
  summary: {
    id: 'Token contoh ditandatangani dengan rahasia HMAC. Pecahkan rahasianya secara offline, lalu tandatangani token adminmu sendiri.',
    en: 'A sample token is signed with an HMAC secret. Crack the secret offline, then sign your own admin token.',
  },
  maps: ['A07:2025', 'CWE-521', 'CWE-326'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Tanda tangan HMAC bisa kamu periksa sendiri tanpa server. Apa yang kamu perlukan untuk mencoba satu tebakan, dan berapa banyak tebakan yang bisa dilakukan per detik?', en: 'You can check an HMAC signature yourself without the server. What do you need to try one guess, and how many guesses per second can you make?' } },
    { id: 2, cost: 20, text: { id: 'Kalau daftar kata polos tidak berhasil, tanyakan bagaimana orang biasanya membuat kata sandi "lebih kuat". Aturan sederhana apa yang bisa kamu tambahkan pada tiap kata?', en: 'If the plain wordlist fails, ask how people usually make a password "stronger". What simple rule could you add to every word?' } },
    { id: 3, cost: 40, text: { id: 'Kalau kunci sekarang kuat, apakah semua kunci lama sudah dimatikan? Adakah token lama yang beredar, dan kunci mana yang menandatanganinya?', en: 'If the current key is strong, were all the old keys switched off? Is an old token lying around somewhere, and which key signed it?' } },
  ],
  mount: (router) => {
    const data = (req: Request, res: Response, token: string, result: Result | null, username: string, password: string) =>
      ({ base: labPath(res), cookie: cookieName(req.level), account: PLAYER, sample: labFor(req).sample, token, result, username, password });

    router.get('/', async (req, res) => {
      await sendPage(res, view, data(req, res, cookieOf(req) ?? '', null, '', ''));
    });

    router.post('/', async (req, res) => {
      const username = field(req, 'username');
      const password = field(req, 'password');
      let result: Result;
      let token = cookieOf(req) ?? '';
      if (username === PLAYER.username && password === PLAYER.password) {
        token = issueToken(req.level, labFor(req), { sub: PLAYER.username, role: 'user' });
        // Not HttpOnly on purpose: the player is meant to edit it (the page says how).
        res.cookie(cookieName(req.level), token, { path: labPath(res), httpOnly: false, sameSite: 'lax' });
        result = { ok: true, text: `Signed in as ${PLAYER.username}. Token issued.` };
      } else {
        result = { ok: false, text: 'Invalid username or password.' };
      }
      await sendPage(res, view, data(req, res, token, result, username, password));
    });

    // The wordlist the weak secrets are drawn from (a published fixture, like a leaked password list).
    router.get('/wordlist.txt', (_req, res) => { sendLines(res, wordlist()); });

    // Release notes: the Inquisitor lab's notes quote an old token "for regression tests" (the leak).
    router.get('/release-notes.txt', (req, res) => {
      const legacy = labFor(req).legacyToken;
      const lines = [
        'Citadel Archive API release notes',
        '',
        '2025.1  Token signing keys now carry a key id (kid) so they can be rotated.',
        '2025.1  The sign-in page now shows a sample token for each new visitor.',
        '2024.4  Fixed a typo in the vault welcome message.',
      ];
      if (legacy !== undefined) {
        lines.push('2024.4  Regression sample from the 2024 key era, kept for the migration tests:', `        ${legacy}`);
      }
      sendLines(res, lines);
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
          result = welcome(req, GK07, { username: typeof sub === 'string' ? sub : 'unknown', role: typeof role === 'string' ? role : 'unknown' });
        }
      }
      await sendPage(res, view, data(req, res, cookieOf(req) ?? '', result, '', ''));
    });
  },
}));
