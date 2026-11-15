// challenge.ts — GK-13 metadata and routes. The guard and routing flaws are in levels/*.ts (served by View Source).
import { join } from 'node:path';
import { Router, type Request, type Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field, labPath } from '../../../core/lab.js';
import { flagFor } from '../../../core/mount.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import type { Level } from '../../../core/levels.js';
import { ADMIN_NAME, PLAYER, type Result } from '../_shared/lab.js';
import { labFor, type AdminLevel, type Wiring } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const labView = join(dir, 'views', 'lab.ejs');
const adminView = join(dir, 'views', 'admin.ejs');
const impl = byLevel<AdminLevel>({ acolyte, templar, inquisitor, divine });

export const GK13 = register(defineChallenge({
  id: 'GK-13', district: 'gatekeeper', slug: 'hidden-admin-function', dir,
  title: { id: 'Fungsi Admin Tersembunyi', en: 'Hidden Admin Function' },
  summary: {
    id: 'Ekspor anggota hanya untuk admin. Jalankan fungsi itu tanpa menjadi admin.',
    en: 'The member export is for admins. Run that function without being an admin.',
  },
  maps: ['A01:2025', 'CWE-285', 'CWE-306'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Fungsi yang tidak ada tautannya belum tentu terlindungi. Berkas apa yang biasanya dibaca perayap web, dan apa yang diumumkan citadel tentang API-nya?', en: 'A function with no link is not necessarily protected. Which file do web crawlers read, and what does the citadel announce about its API?' } },
    { id: 2, cost: 20, text: { id: 'Penjaga dan perute sama-sama membaca alamat. Apakah keduanya membacanya dengan cara yang sama persis, termasuk huruf besar-kecil?', en: 'The guard and the router both read the address. Do they read it in exactly the same way, letter case included?' } },
    { id: 3, cost: 40, text: { id: 'Penjaga yang benar pun tidak berguna kalau ada pintu yang dipasang sebelum ia. Pintu lama apa yang masih didokumentasikan?', en: 'Even a correct guard is useless when a door is mounted before it. Which old door is still documented?' } },
  ],
  mount: (router) => {
    const wiring: Wiring = {
      isAdmin: (req: Request) => labFor(req).user === 'admin',
      exportPage: async (req, res) => {
        const admin = labFor(req).user === 'admin';
        // Anyone but the admin getting the export is the failure; Divine never issues a flag.
        const flag = admin || req.level === 'divine' ? '' : `\nFlag: ${flagFor(req, GK13)}`;
        await sendPage(res, adminView, {
          base: labPath(res), allowed: true, text: `name,role\n${ADMIN_NAME},admin\n${PLAYER.username},user${flag}`,
        });
      },
      denied: async (_req, res) => { await sendPage(res, adminView, { base: labPath(res), allowed: false, text: '' }); },
    };
    // One guarded router per level, each wired by its level module (the order of guard and routes IS the lesson).
    const levelRouters = new Map<Level, Router>();
    const routerFor = (level: Level): Router => {
      let r = levelRouters.get(level);
      if (r === undefined) {
        r = Router();
        impl.for(level).install(r, wiring);
        levelRouters.set(level, r);
      }
      return r;
    };

    const landing = (res: Response, result: Result | null, username: string, password: string) =>
      ({ base: labPath(res), account: PLAYER, result, username, password });

    router.get('/', async (_req, res) => { await sendPage(res, labView, landing(res, null, '', '')); });
    router.post('/', async (req, res) => {
      const username = field(req, 'username');
      const password = field(req, 'password');
      let result: Result;
      if (username === PLAYER.username && password === PLAYER.password) {
        const state = labFor(req);
        if (state.user === 'none') state.user = 'pilgrim';
        result = { ok: true, text: `Signed in as ${PLAYER.username}.` };
      } else {
        result = { ok: false, text: 'Invalid username or password.' };
      }
      await sendPage(res, labView, landing(res, result, username, password));
    });
    router.get('/robots.txt', (req, res) => {
      res.type('text/plain').send(['User-agent: *', ...impl.for(req.level).robots, ''].join('\n'));
    });
    router.get('/openapi.json', (req, res) => {
      const paths = Object.fromEntries(Object.entries(impl.for(req.level).openapi).map(([p, op]) => [p, { get: op }]));
      res.json({ openapi: '3.0.3', info: { title: 'Citadel Console API', version: '1.0.0' }, servers: [{ url: labPath(res) }], paths });
    });
    // Everything else goes to the served level's own guard and routes.
    router.use((req, res, next) => { routerFor(req.level)(req, res, next); });
  },
}));
