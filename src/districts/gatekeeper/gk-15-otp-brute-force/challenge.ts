// challenge.ts — GK-15 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field, labPath } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { ADMIN_NAME, PLAYER, welcome, type Result } from '../_shared/lab.js';
import {
  ACCOUNTS, ADMIN_PASSWORD, issueCode, labFor, type OtpLevel, type Reply,
} from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'otp.ejs');
const impl = byLevel<OtpLevel>({ acolyte, templar, inquisitor, divine });

/** What a level asked us to store in the client's cookies (the lab path, so every spelling of the URL shares them). */
function applyCookies(res: Response, reply: Reply): void {
  for (const [name, value] of Object.entries(reply.cookies ?? {})) {
    res.cookie(name, value, { path: labPath(res), sameSite: 'lax' });
  }
}

export const GK15 = register(defineChallenge({
  id: 'GK-15', district: 'gatekeeper', slug: 'otp-brute-force', dir,
  title: { id: 'Brute Force Kode OTP', en: 'OTP Brute Force' },
  summary: {
    id: 'Kata sandi citadel_admin sudah bocor. Tebak kode OTP 4 digit di langkah kedua dan lewati pembatasannya.',
    en: 'The citadel_admin password leaked. Guess the 4-digit OTP of the second step and get around its limits.',
  },
  maps: ['A07:2025', 'CWE-307', 'CWE-770'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Kode hanya punya 10.000 kemungkinan. Berapa kali server membiarkanmu menebak?', en: 'The code has only 10,000 possible values. How many guesses will the server let you make?' } },
    { id: 2, cost: 20, text: { id: 'Kalau ada batas percobaan, cari tahu apa yang mereset hitungannya, dan di mana hitungan itu disimpan.', en: 'If there is an attempt limit, find out what resets the count, and where the count is stored.' } },
    { id: 3, cost: 40, text: { id: 'Siapa yang memegang hitungan percobaan: server atau kamu? Dan ketika kamu meminta kode baru, apakah rahasia yang kamu tebak benar-benar berganti?', en: 'Who keeps the attempt count, the server or you? And when you ask for a new code, does the secret you are guessing actually change?' } },
  ],
  mount: (router) => {
    /** Run one POST step against the player's lab and say what to show. */
    function step(req: Request, res: Response): Result | null {
      const state = labFor(req);
      const level = impl.for(req.level);
      const cookies = (req.cookies ?? {}) as Record<string, unknown>;
      switch (field(req, 'step')) {
        case 'login': {
          const username = field(req, 'username');
          const password = field(req, 'password');
          const account = ACCOUNTS.find((a) => a.username === username && a.password === password);
          if (!account) return { ok: false, text: 'Invalid username or password.' };
          const gate = level.gate(state, account.username, cookies);
          applyCookies(res, gate);
          if (!gate.ok) return { ok: false, text: gate.message };
          issueCode(state, account.username);
          return { ok: true, text: gate.message };
        }
        case 'resend': {
          if (state.pending === null) return { ok: false, text: 'Sign in first.' };
          const reply = level.resend(state, cookies);
          applyCookies(res, reply);
          return { ok: reply.ok, text: reply.message };
        }
        case 'verify': {
          if (state.pending === null) return { ok: false, text: 'Sign in first.' };
          const reply = level.verify(state, field(req, 'code'), cookies);
          applyCookies(res, reply);
          if (!reply.ok) return { ok: false, text: reply.message };
          const who = ACCOUNTS.find((a) => a.username === state.pending);
          state.pending = null;
          return welcome(req, GK15, who ?? { username: 'stranger', role: 'user' });
        }
        default:
          return null;
      }
    }

    async function render(req: Request, res: Response, result: Result | null): Promise<void> {
      const state = labFor(req);
      // Only the player's own account has an inbox they can read; the admin's code is not shown.
      const inbox = state.pending === PLAYER.username ? state.otp : null;
      await sendPage(res, view, {
        account: PLAYER, target: ADMIN_NAME, targetPassword: ADMIN_PASSWORD,
        pending: state.pending, inbox, result,
        username: field(req, 'username'), password: field(req, 'password'), code: field(req, 'code'),
      });
    }

    router.get('/', (req, res) => render(req, res, null));
    router.post('/', (req, res) => render(req, res, step(req, res)));
  },
}));
