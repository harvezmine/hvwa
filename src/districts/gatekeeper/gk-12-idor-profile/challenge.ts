// challenge.ts — GK-12 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field, header, labPath } from '../../../core/lab.js';
import { flagFor } from '../../../core/mount.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { ADMIN_NAME, PLAYER, type Result } from '../_shared/lab.js';
import { findProfile, labFor, recordsFor, type RecordsLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const recordsView = join(dir, 'views', 'records.ejs');
const profileView = join(dir, 'views', 'profile.ejs');
const impl = byLevel<RecordsLevel>({ acolyte, templar, inquisitor, divine });

type Lookup = { ok: true; username: string; note: string } | { ok: false; message: string };

export const GK12 = register(defineChallenge({
  id: 'GK-12', district: 'gatekeeper', slug: 'idor-profile', dir,
  title: { id: 'IDOR pada Profil', en: 'Insecure Direct Object Reference' },
  summary: {
    id: 'Baca catatan pribadi admin citadel lewat profilnya, padahal itu bukan milikmu.',
    en: 'Read the citadel admin\'s private note through their profile, although it is not yours.',
  },
  maps: ['A01:2025', 'CWE-639', 'CWE-284'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Profilmu punya alamat dengan sebuah id. Apa yang terjadi bila id itu kamu ganti dengan id milik orang lain?', en: 'Your profile has an address with an id in it. What happens if you put someone else\'s id there?' } },
    { id: 2, cost: 20, text: { id: 'Halaman dan API menjawab pertanyaan yang sama. Apakah keduanya sama ketatnya? Dan di mana id yang tidak bisa ditebak mungkin tetap dipublikasikan?', en: 'The page and the API answer the same question. Are both equally strict? And where might an unguessable id be published anyway?' } },
    { id: 3, cost: 40, text: { id: 'Siapa yang menentukan "siapa yang bertanya": sesi di server, atau sesuatu yang bisa kamu tulis sendiri di permintaanmu?', en: 'Who decides "who is asking": the session on the server, or something you can write yourself in your request?' } },
  ],
  mount: (router) => {
    const landing = (req: Request, labBase: string, result: Result | null, username: string, password: string) => {
      const level = impl.for(req.level);
      const r = recordsFor(req.level, level.idStyle);
      return {
        base: labBase, account: PLAYER, target: ADMIN_NAME, result, username, password,
        ownId: labFor(req).signedIn ? r.pilgrim.id : null,
        directory: [r.admin, r.pilgrim].map((p) => ({ username: p.username, id: level.directoryShowsIds ? p.id : null })),
      };
    };

    router.get('/', async (req, res) => {
      await sendPage(res, recordsView, landing(req, labPath(res), null, '', ''));
    });

    router.post('/', async (req, res) => {
      const username = field(req, 'username');
      const password = field(req, 'password');
      let result: Result;
      if (username === PLAYER.username && password === PLAYER.password) {
        labFor(req).signedIn = true;
        result = { ok: true, text: `Signed in as ${PLAYER.username}.` };
      } else {
        result = { ok: false, text: 'Invalid username or password.' };
      }
      await sendPage(res, recordsView, landing(req, labPath(res), result, username, password));
    });

    /** The one lookup both doors share: the level decides access; the flag proves a foreign read. */
    function lookup(req: Request, channel: 'page' | 'api'): Lookup {
      if (!labFor(req).signedIn) return { ok: false, message: 'Sign in first.' };
      const id = typeof req.params.id === 'string' ? req.params.id : '';
      const level = impl.for(req.level);
      const recs = recordsFor(req.level, level.idStyle);
      const owner = findProfile(recs, id);
      const viewer = recs.pilgrim;
      const notFound = { ok: false as const, message: 'Profile not found.' };
      if (owner === undefined) return notFound;
      const allowed = level.canRead({ channel, viewerId: viewer.id, ownerId: owner.id, claimedId: header(req, 'x-user-id') });
      if (!allowed) return level.uniformNotFound ? notFound : { ok: false, message: 'Forbidden: this profile belongs to another user.' };
      // The flag proves the failure: a record that is not yours was served. Divine never issues one.
      const foreign = owner.id !== viewer.id && req.level !== 'divine';
      return { ok: true, username: owner.username, note: foreign ? `${owner.note} Flag: ${flagFor(req, GK12)}` : owner.note };
    }

    router.get('/profile/:id', async (req, res) => {
      const out = lookup(req, 'page');
      await sendPage(res, profileView, {
        base: labPath(res), profile: out.ok ? out : null, message: out.ok ? '' : out.message,
      });
    });

    router.get('/api/profiles/:id', (req, res) => {
      const out = lookup(req, 'api');
      res.json(out.ok ? { username: out.username, note: out.note } : { error: out.message });
    });
  },
}));
