// challenge.ts
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { defineChallenge, register } from '../../../core/registry.js';
import { challengeDb, type ChallengeDb } from '../../../core/challenge-db.js';
import { flagFor } from '../../../core/mount.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import type { Level } from '../../../core/levels.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

export interface UserRow { username: string; role: string }
type FindUser = (db: ChallengeDb, username: string, password: string) => UserRow | undefined;

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'login.ejs');

// Private per-process challenge DB. The admin password is random so guessing it is never the solve.
const db = challengeDb(
  `CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL,
     password TEXT NOT NULL, role TEXT NOT NULL)`,
  (d) => {
    const ins = d.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)');
    ins.run('templar_admin', randomBytes(16).toString('hex'), 'admin');
    ins.run('pilgrim', 'pilgrim', 'user');
  },
);

const FIND: Record<Level, FindUser> = {
  acolyte: acolyte.findUser, templar: templar.findUser,
  inquisitor: inquisitor.findUser, divine: divine.findUser,
};

export const GK01 = register(defineChallenge({
  id: 'GK-01', district: 'gatekeeper', slug: 'sqli-login', dir,
  title: { id: 'Bypass Login SQLi', en: 'SQLi Login Bypass' },
  summary: {
    id: 'Masuk sebagai templar_admin tanpa mengetahui kata sandinya.',
    en: 'Log in as templar_admin without knowing the password.',
  },
  maps: ['A05:2025', 'CWE-89'],
  levels: ['acolyte', 'templar', 'inquisitor', 'divine'],
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Input kamu masuk ke query SQL. Lihat View Source.', en: 'Your input ends up in the SQL query. Check View Source.' } },
    { id: 2, cost: 20, text: { id: 'Kalau satu field difilter, field lain mungkin tidak.', en: 'If one field is filtered, the other one may not be.' } },
    { id: 3, cost: 40, text: { id: 'Buat kondisi WHERE selalu benar, atau buang pengecekan password. Di Inquisitor, ingat arti wildcard pada LIKE.', en: 'Make the WHERE clause always true, or drop the password check. At Inquisitor, remember what LIKE wildcards mean.' } },
  ],
  mount: (router) => {
    router.get('/', (_req, res) => sendPage(res, view, { message: null }));
    router.post('/', async (req, res) => {
      const username = String(req.body?.username ?? '');
      const password = String(req.body?.password ?? '');
      let message: string;
      try {
        const user = FIND[req.level](db, username, password);
        if (user?.role !== 'admin') message = 'Invalid credentials.';
        else if (req.level === 'divine') message = 'Welcome, Templar.'; // Divine never issues a flag
        else message = `Welcome, Templar. Flag: ${flagFor(req, GK01)}`;
      } catch (err) {
        // Below Divine, SQL errors are shown (error-based learning). Divine never leaks them.
        message = req.level === 'divine' ? 'Invalid credentials.' : `Database error: ${(err as Error).message}`;
      }
      await sendPage(res, view, { message });
    });
  },
}));
