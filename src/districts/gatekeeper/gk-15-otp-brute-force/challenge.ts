// challenge.ts — GK-15 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field } from '../../../core/lab.js';
import { flagFor } from '../../../core/mount.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import {
  ACCOUNTS, ADMIN_NAME, ADMIN_PASSWORD, PLAYER, issueCode, labFor, type OtpLevel, type Reply,
} from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'otp.ejs');
const impl = byLevel<OtpLevel>({ acolyte, templar, inquisitor, divine });

/** The lab's message: ok selects the success/error style. */
interface Result { ok: boolean; text: string }

/** What a level asked us to store in the client's cookies. */
function applyCookies(req: Request, res: Response, reply: Reply): void {
  for (const [name, value] of Object.entries(reply.cookies ?? {})) {
    res.cookie(name, value, { path: req.baseUrl, sameSite: 'lax' });
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
    { id: 3, cost: 40, text: { id: 'Templar: apakah "kirim ulang" benar-benar mengganti kodenya? Inquisitor: lihat cookie yang diberikan server dan apa yang terjadi bila kamu tidak mengirimnya kembali.', en: 'Templar: does "resend" really change the code? Inquisitor: look at the cookie the server hands you, and what happens when you do not send it back.' } },
  ],
  mount: (router) => {
    router.all('/', async (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'POST') { next(); return; }
      const state = labFor(req);
      const level = impl.for(req.level);
      const username = field(req, 'username');
      const password = field(req, 'password');
      const code = field(req, 'code');
      let result: Result | null = null;

      if (req.method === 'POST') {
        const step = field(req, 'step');
        const cookies = (req.cookies ?? {}) as Record<string, unknown>;
        if (step === 'login') {
          const account = ACCOUNTS.find((a) => a.username === username && a.password === password);
          if (!account) {
            result = { ok: false, text: 'Invalid username or password.' };
          } else {
            const gate = level.gate(state, account.username);
            applyCookies(req, res, gate);
            if (!gate.ok) {
              result = { ok: false, text: gate.message };
            } else {
              issueCode(state, account.username);
              result = { ok: true, text: gate.message };
            }
          }
        } else if (step === 'verify' || step === 'resend') {
          if (state.pending === null) {
            result = { ok: false, text: 'Sign in first.' };
          } else if (step === 'resend') {
            const reply = level.resend(state, cookies);
            applyCookies(req, res, reply);
            result = { ok: reply.ok, text: reply.message };
          } else {
            const reply = level.verify(state, code, cookies);
            applyCookies(req, res, reply);
            if (!reply.ok) {
              result = { ok: false, text: reply.message };
            } else {
              const who = ACCOUNTS.find((a) => a.username === state.pending);
              state.pending = null;
              const hello = `Welcome, ${who?.username ?? 'stranger'} (role: ${who?.role ?? 'user'}).`;
              if (who?.role !== 'admin') result = { ok: true, text: `${hello} Only the citadel admin holds the flag.` };
              else if (req.level === 'divine') result = { ok: true, text: hello }; // Divine never issues a flag
              else result = { ok: true, text: `${hello} Flag: ${flagFor(req, GK15)}` };
            }
          }
        }
      }

      // Only the player's own account has an inbox they can read; the admin's code is not shown.
      const inbox = state.pending === PLAYER.username ? state.otp : null;
      await sendPage(res, view, {
        account: PLAYER, target: ADMIN_NAME, targetPassword: ADMIN_PASSWORD,
        pending: state.pending, inbox, result, username, password, code,
      });
    });
  },
}));
