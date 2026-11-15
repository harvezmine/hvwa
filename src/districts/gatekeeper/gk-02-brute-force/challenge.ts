// challenge.ts — GK-02 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field } from '../../../core/lab.js';
import { flagFor } from '../../../core/mount.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { ADMIN_NAME, PLAYER, labFor, wordlist, type Account, type BruteLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'login.ejs');
const impl = byLevel<BruteLevel>({ acolyte, templar, inquisitor, divine });

/** The lab's message: ok selects the success/error style. */
interface Result { ok: boolean; text: string }

function welcome(req: Request, account: Account): Result {
  const hello = `Welcome, ${account.username} (role: ${account.role}).`;
  if (account.role !== 'admin') return { ok: true, text: `${hello} Only the citadel admin holds the flag.` };
  if (req.level === 'divine') return { ok: true, text: hello }; // Divine never issues a flag
  return { ok: true, text: `${hello} Flag: ${flagFor(req, GK02)}` };
}

export const GK02 = register(defineChallenge({
  id: 'GK-02', district: 'gatekeeper', slug: 'brute-force', dir,
  title: { id: 'Brute Force Login', en: 'Brute-Force Login' },
  summary: {
    id: 'Tebak kata sandi citadel_admin dengan daftar kata yang bocor, lalu lewati pembatasan percobaannya.',
    en: 'Guess the citadel_admin password with the leaked wordlist, and get around the attempt limits.',
  },
  maps: ['A07:2025', 'CWE-307'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Kata sandi admin ada di daftar kata yang disajikan lab ini. Perhatikan beda pesan galatnya.', en: 'The admin password is in the wordlist this lab serves. Watch how the error messages differ.' } },
    { id: 2, cost: 20, text: { id: 'Kalau akun terkunci setelah beberapa kegagalan, tanyakan: apa yang menghapus hitungan itu, dan hitungan itu dikunci pada apa?', en: 'If an account locks after a few failures, ask what clears the count, and what exactly the count is keyed on.' } },
    { id: 3, cost: 40, text: { id: 'Templar: login sukses mana pun mereset hitungan. Inquisitor: sistem login dan sistem hitungan memperlakukan nama pengguna secara berbeda.', en: 'Templar: any successful login resets the count. Inquisitor: the login and the counter treat the username differently.' } },
  ],
  mount: (router) => {
    router.get('/', (req, res) => sendPage(res, view, { base: req.baseUrl, account: PLAYER, target: ADMIN_NAME, result: null, username: '', password: '' }));
    router.get('/wordlist.txt', (_req, res) => { res.type('text/plain').send(`${wordlist().join('\n')}\n`); });
    router.post('/', async (req, res) => {
      const username = field(req, 'username');
      const password = field(req, 'password');
      const outcome = impl.for(req.level).login(labFor(req), username, password);
      const result: Result = outcome.ok ? welcome(req, outcome.account) : { ok: false, text: outcome.message };
      await sendPage(res, view, { base: req.baseUrl, account: PLAYER, target: ADMIN_NAME, result, username, password });
    });
  },
}));
