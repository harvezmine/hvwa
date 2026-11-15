// challenge.ts — GK-17 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field } from '../../../core/lab.js';
import { flagFor } from '../../../core/mount.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import {
  ADMIN_NAME, GUEST_NAME, PLAYER, labFor, startSession, whoIs, type LabState, type TokenLevel,
} from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const sessionView = join(dir, 'views', 'session.ejs');
const adminView = join(dir, 'views', 'admin.ejs');
const impl = byLevel<TokenLevel>({ acolyte, templar, inquisitor, divine });

const COOKIE = 'citadel_sid';

/** The lab's message: ok selects the success/error style. */
interface Result { ok: boolean; text: string }

function setSession(req: Request, res: Response, token: string): void {
  res.cookie(COOKIE, token, { path: req.baseUrl, httpOnly: true, sameSite: 'lax' });
}

/**
 * Start the lab on the first request: the visitor gets a guest session, then the simulated
 * citadel admin signs in. A visitor whose cookie is not a session of THIS lab (another level's,
 * or none) gets a fresh guest session. Returns the token the visitor now holds.
 */
function begin(req: Request, res: Response, state: LabState, level: TokenLevel): string {
  const cookie: unknown = req.cookies?.[COOKIE];
  if (!state.booted) {
    state.booted = true;
    const guest = startSession(level, state, GUEST_NAME); // the visitor's token ...
    startSession(level, state, ADMIN_NAME);               // ... then the admin signs in ...
    setSession(req, res, guest);                          // ... and the visitor's next token comes after
    return guest;
  }
  if (typeof cookie === 'string' && whoIs(state, cookie) !== undefined) return cookie;
  const guest = startSession(level, state, GUEST_NAME);
  setSession(req, res, guest);
  return guest;
}

export const GK17 = register(defineChallenge({
  id: 'GK-17', district: 'gatekeeper', slug: 'weak-session-id', dir,
  title: { id: 'ID Sesi Lemah', en: 'Weak Session ID' },
  summary: {
    id: 'Admin citadel sudah login. Bajak sesinya dengan menebak ID sesinya, lalu buka halaman admin.',
    en: 'The citadel admin is already signed in. Hijack the session by predicting its ID, then open the admin page.',
  },
  maps: ['A07:2025', 'CWE-330', 'CWE-340'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Lihat ID sesi milikmu dan sesi tamu sebelum login. Apa polanya, dan siapa yang login di sekitar waktu itu?', en: 'Look at your own session ids, the guest one before you sign in and the one after. What pattern do they follow, and who signed in around then?' } },
    { id: 2, cost: 20, text: { id: 'Kalau ID terlihat acak, tanyakan dari apa ia dibuat. Apakah ada masukan yang bisa kamu ketahui atau baca di halaman?', en: 'If an id looks random, ask what it is made from. Is any of the input something you can know or read on the page?' } },
    { id: 3, cost: 40, text: { id: 'Generator yang tidak aman tetap deterministik: dua keluaran milikmu mengapit keluaran lain. Bagian yang disembunyikan hanya 16 bit.', en: 'An insecure generator is still deterministic: two of your outputs sandwich another one. The hidden part is only 16 bits.' } },
  ],
  mount: (router) => {
    const base = (req: Request) => req.baseUrl;

    router.get('/', async (req, res) => {
      const state = labFor(req);
      const level = impl.for(req.level);
      const token = begin(req, res, state, level);
      await sendPage(res, sessionView, page(req, state, level, token, null, '', ''));
    });

    router.post('/', async (req, res) => {
      const state = labFor(req);
      const level = impl.for(req.level);
      let token = begin(req, res, state, level);
      const username = field(req, 'username');
      const password = field(req, 'password');
      let result: Result;
      if (username === PLAYER.username && password === PLAYER.password) {
        token = startSession(level, state, PLAYER.username);
        setSession(req, res, token);
        result = { ok: true, text: `Signed in as ${PLAYER.username}.` };
      } else {
        result = { ok: false, text: 'Invalid username or password.' };
      }
      await sendPage(res, sessionView, page(req, state, level, token, result, username, password));
    });

    router.get('/admin', async (req, res) => {
      const state = labFor(req);
      const level = impl.for(req.level);
      begin(req, res, state, level); // starts the lab if this is the first request
      const cookie: unknown = req.cookies?.[COOKIE];
      const admin = whoIs(state, cookie) === ADMIN_NAME;
      // Only the admin's session sees the flag, and Divine never issues one.
      const note = !admin ? '' : req.level === 'divine' ? 'Welcome back.' : `Flag: ${flagFor(req, GK17)}`;
      await sendPage(res, adminView, { base: base(req), admin, note });
    });

    function page(
      req: Request, state: LabState, level: TokenLevel, token: string, result: Result | null, username: string, password: string,
    ): Record<string, unknown> {
      return {
        base: base(req), account: PLAYER, target: ADMIN_NAME, token, result, username, password,
        activity: state.activity.map((a) => ({ user: a.user, epoch: level.showsLoginTime ? a.epoch : null })),
      };
    }
  },
}));
