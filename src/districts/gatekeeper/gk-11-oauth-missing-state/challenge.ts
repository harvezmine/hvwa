// challenge.ts — GK-11 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { field, labPath } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { sendLinkAction, sendReply, visitOf, type SimBrowser, type Visit } from '../../../core/sim.js';
import { challengeDir } from '../../../core/source.js';
import { ADMIN_NAME, PLAYER, welcome, type Result } from '../_shared/lab.js';
import {
  LINK_REDIRECT, LOGIN_REDIRECT, authorize, citadelSignIn, clientCookie, idpSignIn, impl, labFor, linkCallback, loginCallback,
  logout, openHome, pidCookie, startFlow, whoIs,
} from './model.js';

const dir = challengeDir(import.meta.url);
const view = (name: string): string => join(dir, 'views', `${name}.ejs`);

/** The real request as a Visit: the raw query and only this level's lab cookies. */
const visit = (req: Request, res: Response): Visit => visitOf(req, res, [clientCookie(req.level), pidCookie(req.level)]);

const roleOf = (user: string): 'admin' | 'user' => (user === ADMIN_NAME ? 'admin' : 'user');

/** The admin starts every action signed in to Citadel, whatever the player's last link did. Never browses. */
const rearm = (req: Request, admin: SimBrowser): void => { admin.cookies.set(clientCookie(req.level), labFor(req).adminSession); };

export const GK11 = register(defineChallenge({
  id: 'GK-11', district: 'gatekeeper', slug: 'oauth-missing-state', dir,
  title: { id: 'OAuth Tanpa state (Penautan Akun Paksa)', en: 'OAuth Missing state (Forced Account Linking)' },
  summary: {
    id: 'Tautkan Pilgrim-ID milikmu ke akun Citadel milik admin tanpa sepengetahuannya, lalu masuk dengan Pilgrim-ID-mu sebagai admin.',
    en: 'Link your own Pilgrim-ID to the admin\'s Citadel account behind the admin\'s back, then sign in with your Pilgrim-ID as the admin.',
  },
  maps: ['A07:2025', 'A01:2025', 'CWE-352'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Ikuti alur "Link your Pilgrim-ID" dan baca URL callback-nya. Apa yang membuktikan bahwa callback itu kelanjutan dari alur yang dimulai di peramban yang sama?', en: 'Follow "Link your Pilgrim-ID" and read its callback URL. What proves that the callback continues a flow started in that same browser?' } },
    { id: 2, cost: 20, text: { id: 'Bisakah kamu memegang kode untuk Pilgrim-ID milikmu sendiri yang belum dipakai siapa pun? Apa yang dilakukan callback bila peramban belum masuk ke Citadel?', en: 'Can you end up holding a code for your own Pilgrim-ID that nobody has used yet? What does the callback do in a browser that is not signed in to Citadel?' } },
    { id: 3, cost: 40, text: { id: 'Kalau ada parameter state, kapan Citadel memeriksanya: selalu, atau hanya bila ada? Dan apakah state itu terikat pada sesi yang memulai alurnya, atau cukup asal pernah diterbitkan Citadel?', en: 'If there is a state parameter, when does Citadel check it: always, or only when it is there? And is it tied to the session that started the flow, or is it enough that Citadel once issued it?' } },
  ],
  victim: {
    sim: (req) => labFor(req).world,
    actions: [
      sendLinkAction((req) => labFor(req).admin, {
        rearm,
        description: { id: 'membuka tautan apa pun yang Anda kirim, saat masuk ke Citadel', en: 'opens any link you send, while signed in to Citadel' },
      }),
    ],
  },
  mount: (router) => {
    /** Citadel's home. `client` overrides who is signed in (a sign-in in this very response). */
    const homePage = (req: Request, res: Response, result: Result | null, username: string, password: string, client?: string) => {
      const state = labFor(req);
      const who = whoIs(visit(req, res), state);
      const user = client ?? who.client;
      const linked = user === undefined ? [] : [...state.links].filter(([, c]) => c === user).map(([p]) => p);
      return sendPage(res, view('home'), {
        base: labPath(res), account: PLAYER, target: ADMIN_NAME, linkRedirect: LINK_REDIRECT, loginRedirect: LOGIN_REDIRECT,
        // Signed in to Citadel as the admin: welcome() shows the flag (never at Divine).
        client: user === undefined ? '' : welcome(req, GK11, { username: user, role: roleOf(user) }).text,
        linked, idp: who.idp ?? '', result, username, password,
      });
    };

    router.get('/', (req, res) => sendReply(res, openHome(visit(req, res), labFor(req)), () => homePage(req, res, null, '', '')));

    router.post('/', async (req, res) => {
      const username = field(req, 'username');
      const password = field(req, 'password');
      const r = citadelSignIn(visit(req, res), labFor(req), username, password);
      await sendReply(res, r, () => homePage(req, res, { ok: r.ok, text: r.text }, username, password, r.user));
    });

    const idpPage = (res: Response, result: Result | null, username: string, password: string) =>
      sendPage(res, view('idp'), { base: labPath(res), result, username, password });
    router.get('/idp', (_req, res) => idpPage(res, null, '', ''));
    router.post('/idp', async (req, res) => {
      const username = field(req, 'username');
      const password = field(req, 'password');
      const r = idpSignIn(visit(req, res), labFor(req), username, password);
      await sendReply(res, r, () => idpPage(res, { ok: r.ok, text: r.text }, username, password));
    });

    // The twins of the citadel.test pages. Every Location a page made goes through sendReply, i.e. sendSimRedirect.
    const message = (res: Response, result: Result) => sendPage(res, view('message'), { base: labPath(res), result });
    router.get('/logout', (req, res) => sendReply(res, logout(visit(req, res), labFor(req)), () => message(res, { ok: true, text: '' })));
    router.get('/link', (req, res) => sendReply(res, startFlow(visit(req, res), labFor(req), 'link'), () => message(res, { ok: true, text: '' })));
    router.get('/login', (req, res) => sendReply(res, startFlow(visit(req, res), labFor(req), 'login'), () => message(res, { ok: true, text: '' })));
    router.get('/idp/authorize', (req, res) => {
      const r = authorize(visit(req, res), labFor(req));
      return sendReply(res, r, () => message(res, { ok: r.status < 400, text: r.text }));
    });
    router.get('/link/callback', (req, res) => {
      const r = linkCallback(visit(req, res), labFor(req));
      return sendReply(res, r, () => message(res, { ok: r.ok, text: r.text }));
    });
    router.get('/callback', (req, res) => {
      const r = loginCallback(visit(req, res), labFor(req));
      const result = r.user === undefined ? { ok: false, text: r.text } : welcome(req, GK11, { username: r.user, role: roleOf(r.user) });
      return sendReply(res, r, () => message(res, result));
    });
  },
}));
