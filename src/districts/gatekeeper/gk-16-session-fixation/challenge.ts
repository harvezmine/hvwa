// challenge.ts — GK-16 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { field, labPath } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { classifySimUrl, labHref, sendReply, visitOf, type Visit } from '../../../core/sim.js';
import { challengeDir } from '../../../core/source.js';
import { ADMIN_NAME, PLAYER, curlFor, sendAdminPage } from '../_shared/lab.js';
import {
  adminOpens, cookieName, impl, labFor, portalHome, portalResume, portalSignIn, portalWho, type Portal,
} from './model.js';

const dir = challengeDir(import.meta.url);
const view = (name: string): string => join(dir, 'views', `${name}.ejs`);

/** The real request as a portal Visit: the raw query and this level's portal cookie. */
const visit = (req: Request, res: Response): Visit => visitOf(req, res, [cookieName(req.level)]);

export const GK16 = register(defineChallenge({
  id: 'GK-16', district: 'gatekeeper', slug: 'session-fixation', dir,
  title: { id: 'Fiksasi Sesi', en: 'Session Fixation' },
  summary: {
    id: 'Buat admin citadel masuk pada sesi yang ID-nya sudah kamu ketahui, lalu pakai sesi itu untuk membuka konsol admin.',
    en: 'Make the citadel admin sign in on a session whose id you already know, then use that session to open the admin console.',
  },
  maps: ['A07:2025', 'CWE-384'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Bandingkan ID sesimu sebelum dan sesudah login. Apakah berubah? Dan dari mana saja portal mau menerima ID sesi?', en: 'Compare your session id before and after signing in. Does it change? And from where besides the cookie will the portal take a session id?' } },
    { id: 2, cost: 20, text: { id: 'Kalau peramban admin bisa dibuat memakai ID yang kamu pilih atau yang kamu terima sendiri, apa yang terjadi pada ID itu setelah admin login?', en: 'If the admin\'s browser can be made to use an id you chose, or one the server gave you, what happens to that id once the admin signs in?' } },
    { id: 3, cost: 40, text: { id: 'Rotasi ID saat login hanya menolong bila ID lama langsung mati. Berapa lama ID lama masih dianggap sah, dan apakah ada tautan yang memindahkan sesimu ke peramban lain?', en: 'Rotating the id at login only helps if the old id dies at once. How long is the old id still honoured, and is there a link that moves your session into another browser?' } },
  ],
  victim: {
    sim: (req) => labFor(req).world,
    actions: [{
      name: 'send-link',
      label: { id: 'Kirim tautan sesi ke admin', en: 'Send your session link to the admin' },
      description: {
        id: 'membuka tautan yang Anda kirim di peramban baru, lalu masuk di halaman masuk citadel yang terbuka',
        en: 'opens the link you send in a fresh browser, then signs in on the citadel sign-in page it lands on',
      },
      input: 'url',
      run: (req, { url }) => adminOpens(labFor(req), url), // re-arms first: a fresh browser every time
    }],
  },
  mount: (router) => {
    const home = (req: Request, res: Response, p: Portal, username: string, password: string) =>
      sendReply(res, p, () => sendPage(res, view('portal'), {
        base: labPath(res), account: PLAYER, target: ADMIN_NAME, cookie: cookieName(req.level),
        curl: curlFor(req, res, { path: '/admin', cookies: [`${cookieName(req.level)}=<session id>`] }),
        sid: p.sid, who: p.who ?? '', share: p.share ?? '',
        shareHref: p.share === undefined ? '' : labHref(classifySimUrl(p.share), labPath(res), req.level) ?? '',
        result: p.text === '' ? null : { ok: p.ok, text: p.text }, username, password,
      }));

    router.get('/', (req, res) => home(req, res, portalHome(visit(req, res), labFor(req)), '', ''));

    router.post('/', async (req, res) => {
      const username = field(req, 'username');
      const password = field(req, 'password');
      await home(req, res, portalSignIn(visit(req, res), labFor(req), username, password), username, password);
    });

    // The twin of http://citadel.test/resume: its 302 goes through sendSimRedirect (sendReply), never res.redirect.
    router.get('/resume', (req, res) => {
      const r = portalResume(visit(req, res), labFor(req));
      return sendReply(res, r, () => sendPage(res, view('notice'), { base: labPath(res), text: r.text }));
    });

    router.get('/admin', async (req, res) => {
      // Probing the console never creates a session: it only reads the cookie.
      const admin = portalWho(visit(req, res), labFor(req)) === ADMIN_NAME;
      await sendAdminPage(res, {
        admin, granted: 'Citadel admin console.', flag: { req, challenge: GK16 },
        denial: 'Admin only. This console opens for a session the citadel admin signed in on.',
      });
    });
  },
}));
