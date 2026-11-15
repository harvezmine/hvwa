// challenge.ts — GK-01 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field, tryDb } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { PLAYER, welcome, type Result } from '../_shared/lab.js';
import { usersDb, type LoginLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'login.ejs');
const impl = byLevel<LoginLevel>({ acolyte, templar, inquisitor, divine });

export const GK01 = register(defineChallenge({
  id: 'GK-01', district: 'gatekeeper', slug: 'sqli-login', dir,
  title: { id: 'Bypass Login SQLi', en: 'SQLi Login Bypass' },
  summary: {
    id: 'Masuk sebagai citadel_admin tanpa mengetahui kata sandinya.',
    en: 'Log in as citadel_admin without knowing the password.',
  },
  maps: ['A05:2025', 'CWE-89'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Input kamu masuk ke query SQL. Lihat View Source.', en: 'Your input ends up in the SQL query. Check View Source.' } },
    { id: 2, cost: 20, text: { id: 'Kalau satu field difilter, field lain mungkin tidak.', en: 'If one field is filtered, the other one may not be.' } },
    { id: 3, cost: 40, text: { id: 'Buat kondisi WHERE selalu benar, atau buang pengecekan password. Di Inquisitor, ingat arti wildcard pada LIKE.', en: 'Make the WHERE clause always true, or drop the password check. At Inquisitor, remember what LIKE wildcards mean.' } },
  ],
  mount: (router) => {
    router.get('/', (_req, res) => sendPage(res, view, { account: PLAYER, result: null, username: '', password: '' }));
    router.post('/', async (req, res) => {
      const username = field(req, 'username');
      const password = field(req, 'password');
      const db = usersDb(req.level);
      const level = impl.for(req.level);
      // Only the DB call goes inside tryDb; flagFor() stays outside it.
      const found = tryDb(req, () => level.findUser(db, username, password));
      const result: Result = !found.ok
        ? { ok: false, text: found.message }
        : found.value
          ? welcome(req, GK01, found.value)
          : { ok: false, text: 'Invalid credentials.' };
      await sendPage(res, view, { account: PLAYER, result, username, password });
    });
  },
}));
