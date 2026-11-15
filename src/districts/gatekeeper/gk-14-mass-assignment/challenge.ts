// challenge.ts — GK-14 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field, labPath } from '../../../core/lab.js';
import { flagFor } from '../../../core/mount.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { PLAYER, type Result } from '../_shared/lab.js';
import { labFor, type ProfileLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const profileView = join(dir, 'views', 'profile.ejs');
const adminView = join(dir, 'views', 'admin.ejs');
const impl = byLevel<ProfileLevel>({ acolyte, templar, inquisitor, divine });

export const GK14 = register(defineChallenge({
  id: 'GK-14', district: 'gatekeeper', slug: 'mass-assignment', dir,
  title: { id: 'Mass Assignment', en: 'Mass Assignment' },
  summary: {
    id: 'Ubah profilmu sampai akunmu sendiri menjadi admin, lalu buka halaman admin.',
    en: 'Edit your profile until your own account becomes an admin, then open the admin page.',
  },
  maps: ['A01:2025', 'CWE-915', 'CWE-269'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Formulir hanya menampilkan beberapa kolom. Apakah server hanya membaca kolom itu, atau semua yang kamu kirim?', en: 'The form shows only a few fields. Does the server read only those, or everything you send?' } },
    { id: 2, cost: 20, text: { id: 'Kalau satu kunci diblokir, bagaimana bila data yang sama dikirim di dalam kunci lain? Dan bagaimana server menentukan peran sebenarnya?', en: 'If one key is blocked, what if the same data arrives inside another key? And how does the server decide the real role?' } },
    { id: 3, cost: 40, text: { id: 'Daftar kolom yang diizinkan sudah ketat. Atribut mana yang boleh kamu ubah, dan apa yang diturunkan dari atribut itu?', en: 'The allowed-field list is strict. Which attribute can you change, and what is derived from it?' } },
  ],
  mount: (router) => {
    const page = async (req: Request, res: Response, result: Result | null, username: string, password: string) => {
      const state = labFor(req);
      const u = state.user;
      await sendPage(res, profileView, {
        base: labPath(res), account: PLAYER, result, username, password,
        profile: state.signedIn
          ? { displayName: String(u.displayName), bio: String(u.bio), email: String(u.email), pendingEmail: u.pendingEmail, role: String(u.role) }
          : null,
      });
    };

    const update = async (req: Request, res: Response, body: unknown) => {
      const state = labFor(req);
      const result: Result = state.signedIn ? impl.for(req.level).applyUpdate(state.user, body) : { ok: false, text: 'Sign in first.' };
      await page(req, res, result, '', '');
    };

    router.get('/', async (req, res) => { await page(req, res, null, '', ''); });

    router.post('/', async (req, res) => {
      // The profile form on the page has no action: it posts back here and says so with a hidden field.
      if (field(req, 'intent') === 'update') {
        const { intent: _intent, ...rest } = (req.body ?? {}) as Record<string, unknown>;
        await update(req, res, rest);
        return;
      }
      const username = field(req, 'username');
      const password = field(req, 'password');
      let result: Result;
      if (username === PLAYER.username && password === PLAYER.password) {
        labFor(req).signedIn = true;
        result = { ok: true, text: `Signed in as ${PLAYER.username}.` };
      } else {
        result = { ok: false, text: 'Invalid username or password.' };
      }
      await page(req, res, result, username, password);
    });

    const updateRoute = async (req: Request, res: Response) => { await update(req, res, req.body); };
    router.post('/profile', updateRoute);
    router.put('/profile', updateRoute);

    router.get('/admin', async (req, res) => {
      const admin = labFor(req).user.role === 'admin';
      // Only an account that really became admin sees the flag, and Divine never issues one.
      const note = !admin ? '' : req.level === 'divine' ? 'Welcome back.' : `Flag: ${flagFor(req, GK14)}`;
      await sendPage(res, adminView, { base: labPath(res), admin, note });
    });
  },
}));
