// challenge.ts — FP-09 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, header, labPath } from '../../../core/lab.js';
import { flagFor } from '../../../core/mount.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { ADMIN_NAME, PLAYER, curlFor, forumLogin, type Result } from '../_shared/forum.js';
import { findDm, labFor, type DmLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const inboxView = join(dir, 'views', 'inbox.ejs');
const messageView = join(dir, 'views', 'message.ejs');
const impl = byLevel<DmLevel>({ acolyte, templar, inquisitor, divine });

type Lookup = { ok: true; from: string; to: string; subject: string; body: string } | { ok: false; status: 401 | 403 | 404; message: string };

export const FP09 = register(defineChallenge({
  id: 'FP-09', district: 'forum-of-pilgrims', slug: 'idor-dm', dir,
  title: { id: 'IDOR Pesan Pribadi (BOLA)', en: 'IDOR Private Message (BOLA)' },
  summary: {
    id: 'Baca pesan pribadi admin forum, padahal kamu bukan pengirim maupun penerimanya.',
    en: 'Read the forum admin\'s private message, although you are neither its sender nor its recipient.',
  },
  maps: ['A01:2025', 'API1:2023', 'CWE-639', 'CWE-284'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Sebuah pesan punya pemilik; apa yang memeriksa bahwa itu Anda?', en: 'A message has an owner; what checks that it\'s you?' } },
    { id: 2, cost: 20, text: { id: 'Halaman dan API-nya mungkin tidak memeriksa hal yang sama.', en: 'The page and its API may not check the same thing.' } },
    { id: 3, cost: 40, text: { id: 'Sebuah header yang Anda kirim bukanlah identitas Anda.', en: 'A header you send is not your identity.' } },
  ],
  mount: (router) => {
    const landing = (req: Request, res: Response, result: Result | null, username: string, password: string) => {
      const level = impl.for(req.level);
      const d = labFor(req).dms;
      const own = labFor(req).signedIn ? [d.received, d.sent] : null;
      return {
        base: labPath(res), account: PLAYER, target: ADMIN_NAME, result, username, password, apiNote: level.apiNote,
        curl: curlFor(req, res, { path: '/api/dm/<message id>', headers: level.apiHeaders }),
        inbox: own === null ? null : own.map((m) => ({ id: m.id, from: m.from, to: m.to, subject: m.subject })),
        feed: [d.admin, d.received, d.sent].map((m) => ({ from: m.from, to: m.to, ref: level.feedShowsRefs ? m.id : null })),
      };
    };

    router.get('/', async (req, res) => { await sendPage(res, inboxView, landing(req, res, null, '', '')); });

    router.post('/', async (req, res) => {
      const login = forumLogin(req);
      if (login.ok) labFor(req).signedIn = true;
      await sendPage(res, inboxView, landing(req, res, login.result, login.username, login.password));
    });

    /** The one lookup both doors share: the level decides access; the flag proves a foreign read. */
    function lookup(req: Request, channel: 'page' | 'api'): Lookup {
      if (!labFor(req).signedIn) return { ok: false, status: 401, message: 'Sign in first.' };
      const id = typeof req.params.id === 'string' ? req.params.id : '';
      const level = impl.for(req.level);
      const dm = findDm(labFor(req).dms, id);
      const notFound = { ok: false as const, status: 404 as const, message: 'Message not found.' };
      if (dm === undefined) return notFound;
      const allowed = level.canRead({ channel, viewer: PLAYER.username, from: dm.from, to: dm.to, claimed: header(req, 'x-user-id') });
      if (!allowed) return level.uniformNotFound ? notFound : { ok: false, status: 403, message: 'Forbidden: this is a private message.' };
      // The flag proves the failure: a message you are not a party to was served. Divine never issues one.
      const foreign = dm.from !== PLAYER.username && dm.to !== PLAYER.username && req.level !== 'divine';
      return { ok: true, from: dm.from, to: dm.to, subject: dm.subject, body: foreign ? `${dm.body} Flag: ${flagFor(req, FP09)}` : dm.body };
    }

    router.get('/dm/:id', async (req, res) => {
      const out = lookup(req, 'page');
      res.status(out.ok ? 200 : out.status);
      await sendPage(res, messageView, { base: labPath(res), dm: out.ok ? out : null, message: out.ok ? '' : out.message });
    });

    router.get('/api/dm/:id', (req, res) => {
      const out = lookup(req, 'api');
      res.status(out.ok ? 200 : out.status).json(out.ok
        ? { from: out.from, to: out.to, subject: out.subject, body: out.body }
        : { error: out.message });
    });
  },
}));
