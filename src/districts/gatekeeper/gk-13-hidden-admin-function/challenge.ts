// challenge.ts — GK-13 metadata and routes. The guard and routing flaws are in levels/*.ts (served by View Source).
import { join } from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, labPath, sendLines } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import type { Level } from '../../../core/levels.js';
import { ADMIN_NAME, PLAYER, adminNote, curlFor, pilgrimLogin, sendAdminPage, type Result } from '../_shared/lab.js';
import { labFor, type AdminLevel, type Wiring } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const labView = join(dir, 'views', 'lab.ejs');
const impl = byLevel<AdminLevel>({ acolyte, templar, inquisitor, divine });

export const GK13 = register(defineChallenge({
  id: 'GK-13', district: 'gatekeeper', slug: 'hidden-admin-function', dir,
  title: { id: 'Fungsi Admin Tersembunyi', en: 'Hidden Admin Function' },
  summary: {
    id: 'Ekspor anggota hanya untuk admin. Jalankan fungsi itu tanpa menjadi admin.',
    en: 'The member export is for admins. Run that function without being an admin.',
  },
  maps: ['A01:2025', 'API5:2023', 'CWE-285', 'CWE-306'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Baca apa yang diminta citadel agar dihindari perayap web. Apakah "hindari" sama dengan "dilarang"? Apa yang sebenarnya memaksakannya?', en: 'Read what the citadel asks web crawlers to avoid. Is "avoid" the same as "forbidden"? What actually enforces it?' } },
    { id: 2, cost: 20, text: { id: 'Penjaga dan perute sama-sama membaca alamat. Apakah keduanya membacanya dengan cara yang sama persis, termasuk huruf besar-kecil?', en: 'The guard and the router both read the address. Do they read it in exactly the same way, letter case included?' } },
    { id: 3, cost: 40, text: { id: 'Penjaga yang benar pun tidak berguna kalau ada pintu yang dipasang sebelum ia. Pintu lama apa yang masih didokumentasikan?', en: 'Even a correct guard is useless when a door is mounted before it. Which old door is still documented?' } },
  ],
  mount: (router) => {
    const denial = 'Admin only. This function is for the citadel admin.';
    const wiring: Wiring = {
      isAdmin: (req: Request) => labFor(req).user === 'admin',
      exportPage: async (req, res) => {
        const admin = labFor(req).user === 'admin';
        // Anyone but the admin getting the export is the failure; Divine never issues a flag.
        const flag = admin ? '' : adminNote(req, GK13, true);
        await sendAdminPage(res, { admin: true, granted: 'Member export', denial, pre: `name,role
${ADMIN_NAME},admin
${PLAYER.username},user${flag ? `
${flag}` : ''}` });
      },
      denied: (_req: Request, res: Response, next: NextFunction) => {
        sendAdminPage(res, { admin: false, granted: '', denial }).catch(next); // never leave a rejection dangling
      },
      requireSignIn: (req, res, next) => {
        if (labFor(req).user !== 'none') { next(); return; }
        res.status(401);
        sendAdminPage(res, { admin: false, granted: '', denial: 'Sign in first.', denyStatus: 401 }).catch(next);
      },
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

    const landing = (req: Request, res: Response, result: Result | null, username: string, password: string) =>
      ({ base: labPath(res), account: PLAYER, curl: curlFor(req, res, { path: '/robots.txt' }), result, username, password });

    router.get('/', async (req, res) => { await sendPage(res, labView, landing(req, res, null, '', '')); });
    router.post('/', async (req, res) => {
      const login = pilgrimLogin(req);
      if (login.ok) {
        const state = labFor(req);
        if (state.user === 'none') state.user = 'pilgrim';
      }
      await sendPage(res, labView, landing(req, res, login.result, login.username, login.password));
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
