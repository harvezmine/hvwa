// challenge.ts — GK-02 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import { defineChallenge, register } from '../../../core/registry.js';
import { sendLines } from '../../../core/fixtures.js';
import { byLevel, field, labPath } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { ADMIN_NAME, PLAYER, welcome, type Result } from '../_shared/lab.js';
import { labFor, wordlist, type BruteLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'login.ejs');
const impl = byLevel<BruteLevel>({ acolyte, templar, inquisitor, divine });

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
    { id: 1, cost: 10, text: { id: 'Sebelum menebak kata sandi, tanyakan: apakah jawaban server berbeda untuk nama yang ada dan yang tidak ada?', en: 'Before guessing any password, ask: does the server answer differently for a name that exists and one that does not?' } },
    { id: 2, cost: 20, text: { id: 'Kalau akun terkunci setelah beberapa kegagalan, tanyakan: apa yang menghapus hitungan itu, dan hitungan itu dikunci pada apa?', en: 'If an account locks after a few failures, ask what clears the count, and what exactly the count is keyed on.' } },
    { id: 3, cost: 40, text: { id: 'Selain menunggu, apa lagi yang membuat kunci lupa? Dan apakah pencocokan nama dan kunci hitungan memandang nama itu dengan cara yang sama?', en: 'Besides waiting, what else makes the lock forget? And do the login match and the counter key see the username the same way?' } },
  ],
  mount: (router) => {
    const data = (res: Parameters<typeof labPath>[0], result: Result | null, username: string, password: string) =>
      ({ base: labPath(res), account: PLAYER, target: ADMIN_NAME, result, username, password });
    router.get('/', (_req, res) => sendPage(res, view, data(res, null, '', '')));
    router.get('/wordlist.txt', (_req, res) => { sendLines(res, wordlist()); });
    router.post('/', async (req, res) => {
      const username = field(req, 'username');
      const password = field(req, 'password');
      const outcome = impl.for(req.level).login(labFor(req), username, password);
      const result: Result = outcome.ok ? welcome(req, GK02, outcome.account) : { ok: false, text: outcome.message };
      await sendPage(res, view, data(res, result, username, password));
    });
  },
}));
