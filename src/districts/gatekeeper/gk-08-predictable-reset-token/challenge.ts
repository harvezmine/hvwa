// challenge.ts — GK-08 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field, labPath } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { ADMIN_NAME, PLAYER, welcome, type Result } from '../_shared/lab.js';
import {
  ADMIN_EMAIL, PLAYER_EMAIL, deliverToPlayer, labFor, memberByEmail, type LabState, type ResetLevel,
} from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = (name: string): string => join(dir, 'views', `${name}.ejs`);
const impl = byLevel<ResetLevel>({ acolyte, templar, inquisitor, divine });

/** Longest new password kept (the lab stores it). */
const MAX_PASSWORD = 128;
const SENT = 'If an account uses that address, a reset link is on its way.';
const INVALID = 'This reset link is invalid or has expired.';

/** Shown on every page: the player's own mailbox, newest first. */
function mailboxOf(state: LabState): { at: string; subject: string; body: string; link: string }[] {
  return state.mailbox.map((m) => ({ at: new Date(m.at).toISOString(), subject: m.subject, body: m.body, link: m.link }));
}

function common(req: Request, res: Response): Record<string, unknown> {
  return { base: labPath(res), playerEmail: PLAYER_EMAIL, mailbox: mailboxOf(labFor(req)) };
}

export const GK08 = register(defineChallenge({
  id: 'GK-08', district: 'gatekeeper', slug: 'predictable-reset-token', dir,
  title: { id: 'Token Reset yang Mudah Ditebak', en: 'Predictable Reset Token' },
  summary: {
    id: 'Ambil alih akun citadel_admin lewat fitur lupa kata sandi: tautan reset-nya tidak seaman kelihatannya.',
    en: 'Take over the citadel_admin account through the forgot-password feature: its reset links are not as safe as they look.',
  },
  maps: ['A07:2025', 'CWE-640', 'CWE-330', 'CWE-639'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Minta reset untuk akunmu sendiri dan perhatikan token di tautannya. Apakah token itu acak, atau dibuat dari sesuatu yang kamu ketahui?', en: 'Ask for a reset of your own account and look closely at the token in the link. Is it random, or made from something you know?' } },
    { id: 2, cost: 20, text: { id: 'Kalau token terlihat seperti hash, tebak bahannya: apa yang diketahui server tentang permintaanmu yang juga kamu ketahui (untuk siapa, dan kapan menurut jam server)?', en: 'If a token looks like a hash, guess its ingredients: what does the server know about your request that you know too (who it is for, and when by the server\'s clock)?' } },
    { id: 3, cost: 40, text: { id: 'Ketika formulir reset mengganti kata sandi, siapa yang menentukan akun mana: token yang dikirim lewat surat, atau kolom yang bisa kamu ubah sendiri?', en: 'When the reset form changes a password, who decides whose: the token that came by mail, or a field you can edit yourself?' } },
  ],
  mount: (router) => {
    const home = (req: Request, res: Response, result: Result | null, username: string, password: string) =>
      sendPage(res, view('home'), {
        ...common(req, res), account: PLAYER, target: ADMIN_NAME, targetEmail: ADMIN_EMAIL, result, username, password,
      });

    router.get('/', (req, res) => home(req, res, null, '', ''));

    router.post('/', async (req, res) => {
      const username = field(req, 'username');
      const password = field(req, 'password');
      const member = labFor(req).members.find((m) => m.username === username && m.password === password);
      // Only the admin's account holds the flag, and Divine never issues one (welcome() decides).
      const result = member ? welcome(req, GK08, member) : { ok: false, text: 'Invalid username or password.' };
      await home(req, res, result, username, password);
    });

    const forgotPage = (req: Request, res: Response, result: Result | null, email: string) =>
      sendPage(res, view('forgot'), { ...common(req, res), result, email });

    router.get('/forgot', (req, res) => forgotPage(req, res, null, ''));

    router.post('/forgot', async (req, res) => {
      const email = field(req, 'email');
      const state = labFor(req);
      const level = impl.for(req.level);
      const member = memberByEmail(state, email);
      if (member !== undefined) {
        const token = level.issue(state, member, state.now());
        const forEmail = level.formHasEmail ? `&email=${encodeURIComponent(member.email)}` : '';
        const link = `${labPath(res)}/reset?token=${encodeURIComponent(token)}${forEmail}&level=${req.level}`;
        // The admin's mail goes to the admin's mailbox, which this lab never shows; only the player's mail is kept.
        if (member.email === PLAYER_EMAIL) {
          deliverToPlayer(state, {
            at: state.now(), subject: 'Reset your Citadel password',
            body: `Someone asked to reset the password of ${member.email}. Open the link to choose a new one.`, link,
          });
        }
      }
      // The same answer for every address, so the form does not tell which accounts exist.
      await forgotPage(req, res, { ok: true, text: SENT }, email);
    });

    const resetPage = (req: Request, res: Response, result: Result | null, token: string, email: string) =>
      sendPage(res, view('reset'), { ...common(req, res), result, token, email, withEmail: impl.for(req.level).formHasEmail });

    const queryString = (req: Request, name: string): string => (typeof req.query[name] === 'string' ? req.query[name] : '');

    router.get('/reset', (req, res) => resetPage(req, res, null, queryString(req, 'token'), queryString(req, 'email')));

    router.post('/reset', async (req, res) => {
      const token = field(req, 'token');
      const email = field(req, 'email');
      const password = field(req, 'password');
      const state = labFor(req);
      let result: Result;
      if (password === '' || password.length > MAX_PASSWORD) {
        // Checked before the token, so a mistyped password does not use the link up.
        result = { ok: false, text: `Choose a new password (1 to ${MAX_PASSWORD} characters).` };
      } else {
        const member = impl.for(req.level).redeem(state, { token, email }, state.now());
        if (member === undefined) result = { ok: false, text: INVALID };
        else {
          member.password = password;
          result = { ok: true, text: `Password updated for ${member.username}. Sign in with your new password.` };
        }
      }
      await resetPage(req, res, result, token, email);
    });
  },
}));
