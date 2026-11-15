// challenge.ts — GK-12 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, header, labPath } from '../../../core/lab.js';
import { flagFor } from '../../../core/mount.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { ADMIN_NAME, PLAYER, curlFor, pilgrimLogin, type Result } from '../_shared/lab.js';
import { findProfile, labFor, type RecordsLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const recordsView = join(dir, 'views', 'records.ejs');
const profileView = join(dir, 'views', 'profile.ejs');
const impl = byLevel<RecordsLevel>({ acolyte, templar, inquisitor, divine });

type Lookup = { ok: true; username: string; note: string } | { ok: false; status: 401 | 403 | 404; message: string };

export const GK12 = register(defineChallenge({
  id: 'GK-12', district: 'gatekeeper', slug: 'idor-profile', dir,
  title: { id: 'IDOR pada Profil', en: 'Insecure Direct Object Reference' },
  summary: {
    id: 'Baca catatan pribadi admin citadel lewat profilnya, padahal itu bukan milikmu.',
    en: 'Read the citadel admin\'s private note through their profile, although it is not yours.',
  },
  maps: ['A01:2025', 'API1:2023', 'CWE-639', 'CWE-284'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Profilmu punya alamat dengan sebuah id. Apa yang terjadi bila id itu kamu ganti dengan id milik orang lain?', en: 'Your profile has an address with an id in it. What happens if you put someone else\'s id there?' } },
    { id: 2, cost: 20, text: { id: 'Perbaikan di satu pintu belum tentu berlaku di pintu lain. Apakah setiap cara bertanya hal yang sama menerapkan aturan yang sama? Dan bisakah id yang sulit ditebak tetap ditemukan di tempat umum?', en: 'A fix on one door is not a fix on the others. Does every way of asking the same question enforce the same rule? And can a hard-to-guess id still be found in a public place?' } },
    { id: 3, cost: 40, text: { id: 'Siapa yang menentukan "siapa yang bertanya": sesi di server, atau sesuatu yang bisa kamu tulis sendiri di permintaanmu?', en: 'Who decides "who is asking": the session on the server, or something you can write yourself in your request?' } },
  ],
  mount: (router) => {
    const landing = (req: Request, res: Response, result: Result | null, username: string, password: string) => {
      const level = impl.for(req.level);
      const r = labFor(req).records;
      return {
        base: labPath(res), account: PLAYER, target: ADMIN_NAME, result, username, password,
        ownId: labFor(req).signedIn ? r.pilgrim.id : null, apiNote: level.apiNote,
        curl: curlFor(req, res, { path: '/api/profiles/<profile id>', headers: level.apiHeaders }),
        directory: [r.admin, r.pilgrim].map((p) => ({ username: p.username, id: level.directoryShowsIds ? p.id : null })),
      };
    };

    router.get('/', async (req, res) => { await sendPage(res, recordsView, landing(req, res, null, '', '')); });

    router.post('/', async (req, res) => {
      const login = pilgrimLogin(req);
      if (login.ok) labFor(req).signedIn = true;
      await sendPage(res, recordsView, landing(req, res, login.result, login.username, login.password));
    });

    /** The one lookup both doors share: the level decides access; the flag proves a foreign read. */
    function lookup(req: Request, channel: 'page' | 'api'): Lookup {
      if (!labFor(req).signedIn) return { ok: false, status: 401, message: 'Sign in first.' };
      const id = typeof req.params.id === 'string' ? req.params.id : '';
      const level = impl.for(req.level);
      const recs = labFor(req).records;
      const owner = findProfile(recs, id);
      const viewer = recs.pilgrim;
      const notFound = { ok: false as const, status: 404 as const, message: 'Profile not found.' };
      if (owner === undefined) return notFound;
      const allowed = level.canRead({ channel, viewerId: viewer.id, ownerId: owner.id, claimedId: header(req, 'x-user-id') });
      if (!allowed) return level.uniformNotFound ? notFound : { ok: false, status: 403, message: 'Forbidden: this profile belongs to another user.' };
      // The flag proves the failure: a record that is not yours was served. Divine never issues one.
      const foreign = owner.id !== viewer.id && req.level !== 'divine';
      return { ok: true, username: owner.username, note: foreign ? `${owner.note} Flag: ${flagFor(req, GK12)}` : owner.note };
    }

    router.get('/profile/:id', async (req, res) => {
      const out = lookup(req, 'page');
      res.status(out.ok ? 200 : out.status);
      await sendPage(res, profileView, {
        base: labPath(res), profile: out.ok ? out : null, message: out.ok ? '' : out.message,
      });
    });

    router.get('/api/profiles/:id', (req, res) => {
      const out = lookup(req, 'api');
      res.status(out.ok ? 200 : out.status).json(out.ok ? { username: out.username, note: out.note } : { error: out.message });
    });
  },
}));
