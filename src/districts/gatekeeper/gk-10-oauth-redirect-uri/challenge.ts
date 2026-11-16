// challenge.ts — GK-10 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { field, labPath } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { sendLinkAction, sendReply, visitOf, type SimBrowser, type Visit } from '../../../core/sim.js';
import { challengeDir } from '../../../core/source.js';
import { ADMIN_NAME, PLAYER, welcome, type Result } from '../_shared/lab.js';
import {
  REGISTERED_REDIRECT, authorize, callback, clientCookie, idpSignIn, impl, labFor, loginCookie, nextCookie, pidCookie,
  startLogin, whoIs,
} from './model.js';

const dir = challengeDir(import.meta.url);
const view = (name: string): string => join(dir, 'views', `${name}.ejs`);

/** The real request as a Visit: the raw query and only this level's lab cookies. */
const visit = (req: Request, res: Response): Visit =>
  visitOf(req, res, [pidCookie, clientCookie, nextCookie, loginCookie].map((f) => f(req.level)));

const roleOf = (user: string): 'admin' | 'user' => (user === ADMIN_NAME ? 'admin' : 'user');

/** The admin starts every action signed in to Pilgrim-ID, whatever the player's last link did. Never browses. */
const rearm = (req: Request, admin: SimBrowser): void => { admin.cookies.set(pidCookie(req.level), labFor(req).adminPid); };

export const GK10 = register(defineChallenge({
  id: 'GK-10', district: 'gatekeeper', slug: 'oauth-redirect-uri', dir,
  title: { id: 'Pencurian Kode OAuth lewat redirect_uri', en: 'OAuth redirect_uri Code Theft' },
  summary: {
    id: 'Admin sudah masuk ke Pilgrim-ID. Buat kode otorisasinya sampai ke servermu, lalu tukarkan untuk masuk ke Citadel sebagai admin.',
    en: 'The admin is signed in to Pilgrim-ID. Make the admin\'s authorization code reach your server, then exchange it to sign in to Citadel as the admin.',
  },
  maps: ['A07:2025', 'CWE-601', 'CWE-598'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Ikuti alur "Sign in with Pilgrim-ID" di perambanmu sendiri dan baca setiap URL di jalannya. Parameter mana yang menentukan ke mana kode dikirim?', en: 'Follow "Sign in with Pilgrim-ID" in your own browser and read every URL on the way. Which parameter decides where the code is sent?' } },
    { id: 2, cost: 20, text: { id: 'Kalau Pilgrim-ID memeriksa parameter itu, apakah ia menuntut kecocokan persis, atau ujian yang lebih longgar? Apa lagi yang lolos ujian longgar itu?', en: 'If Pilgrim-ID checks that parameter, does it demand an exact match, or a looser test? What else would pass the looser test?' } },
    { id: 3, cost: 40, text: { id: 'Bila tujuannya harus persis, kode tetap mendarat di halaman callback Citadel. Ke mana halaman itu membawa peramban sesudahnya, dan apa yang diceritakan peramban kepada halaman berikutnya tentang halaman asalnya?', en: 'When the target must match exactly, the code still lands on Citadel\'s callback page. Where does that page take the browser next, and what does a browser tell the next page about the one it came from?' } },
  ],
  victim: {
    sim: (req) => labFor(req).world,
    actions: [
      sendLinkAction((req) => labFor(req).admin, {
        rearm,
        description: { id: 'membuka tautan apa pun yang Anda kirim, saat masuk ke Pilgrim-ID', en: 'opens any link you send, while signed in to Pilgrim-ID' },
      }),
    ],
  },
  mount: (router) => {
    const home = (req: Request, res: Response, result: Result | null, username: string, password: string, idpNow?: string) => {
      const who = whoIs(visit(req, res), labFor(req));
      // Signed in to Citadel as the admin: welcome() shows the flag (never at Divine).
      const client = who.client === undefined ? '' : welcome(req, GK10, { username: who.client, role: roleOf(who.client) }).text;
      return sendPage(res, view('home'), {
        base: labPath(res), account: PLAYER, target: ADMIN_NAME, redirect: REGISTERED_REDIRECT,
        idp: idpNow ?? who.idp ?? '', client, result, username, password,
      });
    };

    router.get('/', (req, res) => home(req, res, null, '', ''));

    router.post('/', async (req, res) => {
      const username = field(req, 'username');
      const password = field(req, 'password');
      const r = idpSignIn(visit(req, res), labFor(req), username, password);
      await sendReply(res, r, () => home(req, res, { ok: r.ok, text: r.text }, username, password, r.ok ? username : undefined));
    });

    // The twins of http://citadel.test/login, /idp/authorize and /callback. Every Location or forward a level made
    // goes through sendReply, i.e. sendSimRedirect: never res.redirect() to a redirect_uri or a next.
    router.get('/login', (req, res) => sendReply(res, startLogin(visit(req, res), labFor(req)), () => home(req, res, null, '', '')));

    router.get('/idp/authorize', (req, res) => {
      const r = authorize(visit(req, res), labFor(req));
      return sendReply(res, r, () => sendPage(res, view('idp'), { base: labPath(res), text: r.text, failed: r.status >= 400 }));
    });

    router.get('/callback', (req, res) => {
      const r = callback(visit(req, res), labFor(req));
      const result = r.user === undefined ? { ok: false, text: r.text } : welcome(req, GK10, { username: r.user, role: roleOf(r.user) });
      // A forward (Inquisitor's next=) is rendered with a note, the welcome and its flag included: never followed here.
      return sendReply(res, r, (forward) => sendPage(res, view('callback'), { base: labPath(res), result, forward: forward ?? null }));
    });
  },
}));
