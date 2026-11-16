// challenge.ts — GK-09 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field, header, labPath } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { ADMIN_MAILBOX, PLAYER_MAILBOX, checkMailAction, sendSimRedirect } from '../../../core/sim.js';
import { challengeDir } from '../../../core/source.js';
import { ADMIN_NAME, PLAYER, curlFor, welcome, type Result } from '../_shared/lab.js';
import {
  RESET_INVALID, checkReset, issueReset, labFor, memberByEmail, redeemReset, type LinkLevel,
} from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = (name: string): string => join(dir, 'views', `${name}.ejs`);
const impl = byLevel<LinkLevel>({ acolyte, templar, inquisitor, divine });

const MAX_PASSWORD = 128;
const SENT = 'If an account uses that address, a reset link is on its way.';

export const GK09 = register(defineChallenge({
  id: 'GK-09', district: 'gatekeeper', slug: 'reset-host-poisoning', dir,
  title: { id: 'Peracunan Host pada Tautan Reset', en: 'Reset Link Host-Header Poisoning' },
  summary: {
    id: 'Buat surat reset kata sandi citadel_admin menautkan ke servermu, curi tokennya saat admin mengklik, lalu ambil alih akunnya.',
    en: 'Make the citadel_admin\'s password-reset mail link to your server, steal the token when the admin clicks it, then take over the account.',
  },
  maps: ['A07:2025', 'CWE-640', 'CWE-346'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Tautan reset di surat adalah URL absolut. Dari mana citadel mendapat nama host yang ia tulis di dalamnya?', en: 'The reset link in the mail is an absolute URL. Where does the citadel get the host name it writes into it?' } },
    { id: 2, cost: 20, text: { id: 'Di balik proxy, aplikasi mengetahui namanya sendiri dari header yang ditambahkan proxy. Mana yang bisa kamu kirim sendiri, dan apa yang diperiksa tiap level tentang nilainya?', en: 'Behind a proxy, an app learns its own name from headers the proxy adds. Which of them can you send yourself, and what does each level check about the value?' } },
    { id: 3, cost: 40, text: { id: 'Kalau pemeriksaan hanya mencari sebuah kata di suatu tempat dalam nama host, siapa lagi yang bisa punya nama dengan kata itu? Dan adakah header standar selain yang berawalan X-?', en: 'If a check only looks for a word somewhere in the host name, who else can own a name with that word in it? And is there a standard header besides the X- ones?' } },
  ],
  victim: {
    sim: (req) => labFor(req).world,
    actions: [
      // The admin is not signed in to anything: there is no standing state to restore.
      checkMailAction({ browser: (req) => labFor(req).admin, mailbox: ADMIN_MAILBOX, rearm: () => {} }),
    ],
  },
  mount: (router) => {
    const home = (req: Request, res: Response, result: Result | null, username: string, password: string) =>
      sendPage(res, view('home'), {
        base: labPath(res), account: PLAYER, playerEmail: PLAYER_MAILBOX, target: ADMIN_NAME, targetEmail: ADMIN_MAILBOX,
        curl: curlFor(req, res, { path: '/forgot', headers: ['<Header>: <value>'], form: { email: ADMIN_MAILBOX } }),
        result, username, password,
      });

    router.get('/', (req, res) => home(req, res, null, '', ''));

    router.post('/', async (req, res) => {
      const username = field(req, 'username');
      const password = field(req, 'password');
      const member = labFor(req).members.find((m) => m.username === username && m.password === password);
      // Only the admin's account holds the flag, and Divine never issues one (welcome() decides).
      const result = member ? welcome(req, GK09, member) : { ok: false, text: 'Invalid username or password.' };
      await home(req, res, result, username, password);
    });

    const forgotPage = (res: Response, result: Result | null, email: string) =>
      sendPage(res, view('forgot'), { base: labPath(res), result, email });

    router.get('/forgot', (_req, res) => forgotPage(res, null, ''));
    router.get('/forgot/sent', (_req, res) => forgotPage(res, { ok: true, text: SENT }, ''));

    router.post('/forgot', async (req, res) => {
      const state = labFor(req);
      const origin = impl.for(req.level).linkOrigin((name) => header(req, name));
      const member = memberByEmail(state, field(req, 'email'));
      if (member !== undefined) {
        const token = issueReset(state, member);
        state.world.inbox.deliver({
          from: 'no-reply@citadel.test', to: member.email, subject: 'Reset your Citadel password',
          body: `Someone asked to reset the password of ${member.email}. Open the link to choose a new one.`,
          links: [`${origin}/reset?token=${token}`],
        });
      }
      // The same answer for every address. The redirect is built on the same origin as the mail link (an app that
      // trusts a forwarded host does so everywhere); sendSimRedirect keeps your real browser in the lab whatever it is.
      await sendSimRedirect(res, `${origin}/forgot/sent`, 303);
    });

    const resetPage = (res: Response, result: Result | null, token: string) =>
      sendPage(res, view('reset'), { base: labPath(res), result, token });

    router.get('/reset', async (req, res) => {
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      const live = token === '' || checkReset(labFor(req), token) !== undefined;
      await resetPage(res, live ? null : { ok: false, text: RESET_INVALID }, token);
    });

    router.post('/reset', async (req, res) => {
      const token = field(req, 'token');
      const password = field(req, 'password');
      let result: Result;
      if (password === '' || password.length > MAX_PASSWORD) {
        // Checked before the token, so a mistyped password does not use the link up.
        result = { ok: false, text: `Choose a new password (1 to ${MAX_PASSWORD} characters).` };
      } else {
        const member = redeemReset(labFor(req), token);
        if (member === undefined) result = { ok: false, text: RESET_INVALID };
        else {
          member.password = password;
          result = { ok: true, text: `Password updated for ${member.username}. Sign in with your new password.` };
        }
      }
      await resetPage(res, result, token);
    });
  },
}));
