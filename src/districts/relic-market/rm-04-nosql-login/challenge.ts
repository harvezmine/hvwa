// challenge.ts — RM-04 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field, tryDb } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { curlFor } from '../../_shared/curl.js';
import type { Result } from '../../_shared/result.js';
import { welcome } from '../_shared/shop-lab.js';
import { PLAYER, staffStore, type LoginLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'portal.ejs');
const impl = byLevel<LoginLevel>({ acolyte, templar, inquisitor, divine });

async function page(req: Request, res: Response, result: Result | null): Promise<void> {
  await sendPage(res, view, {
    account: PLAYER, result, username: field(req, 'username'), password: field(req, 'password'),
    curl: curlFor(req, res, { path: '/', form: { username: PLAYER.username, password: PLAYER.password }, signIn: false }),
    curlJson: curlFor(req, res, { path: '/', headers: ['Content-Type: application/json'], data: JSON.stringify({ username: PLAYER.username, password: PLAYER.password }), signIn: false }),
  });
}

export const RM04 = register(defineChallenge({
  id: 'RM-04', district: 'relic-market', slug: 'nosql-login', dir,
  title: { id: 'Injeksi NoSQL pada Login', en: 'NoSQL Injection Login' },
  summary: {
    id: 'Masuk ke portal staf sebagai relic_admin tanpa mengetahui kata sandinya.',
    en: 'Sign in to the staff portal as relic_admin without knowing the password.',
  },
  maps: ['A05:2025', 'CWE-943'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Basis data dokumen mencocokkan field dengan sebuah objek query. Apa yang terjadi bila password yang kamu kirim bukan teks, melainkan objek?', en: 'A document database matches fields against a query object. What happens if the password you send is not text but an object?' } },
    { id: 2, cost: 20, text: { id: 'Daftar hitam hanya memblokir beberapa operator. Operator perbandingan lain mana yang juga cocok dengan kata sandi apa pun?', en: 'The blacklist blocks only a few operators. Which other comparison operators also match any password?' } },
    { id: 3, cost: 40, text: { id: 'Di Inquisitor input dipaksa menjadi teks lalu ditempel ke dalam ekspresi $where. Bagaimana teksmu bisa mengakhiri string itu dan mengubah sisa ekspresinya?', en: 'At Inquisitor inputs are forced to text and pasted into a $where expression. How could your text end that string and change the rest of the expression?' } },
  ],
  // No Restart: nothing here mutates, and there is no limiter or budget to reset.
  mount: (router) => {
    router.get('/', async (req, res) => { await page(req, res, null); });
    router.post('/', async (req, res) => {
      // Only the store call goes inside tryDb (label "Query error"); welcome() calls flagFor and stays outside it.
      const found = tryDb(req, () => impl.for(req.level).login(staffStore(req.level), req.body), 'Query error');
      let result: Result;
      if (!found.ok) result = { ok: false, text: found.message };
      else if (typeof found.value === 'string') result = { ok: false, text: found.value };
      else if (found.value === null) result = { ok: false, text: 'Invalid username or password.' };
      else result = welcome(req, RM04, { username: found.value.username ?? '', role: found.value.role ?? '' });
      await page(req, res, result);
    });
  },
}));
