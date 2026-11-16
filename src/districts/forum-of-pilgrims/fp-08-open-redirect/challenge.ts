// challenge.ts — FP-08 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { field, labPath } from '../../../core/lab.js';
import { flagFor } from '../../../core/mount.js';
import { sendPage } from '../../../core/render.js';
import { VICTIM_LABELS, sendReply, visitOf, type Visit } from '../../../core/sim.js';
import { challengeDir } from '../../../core/source.js';
import { ADMIN_NAME, THREADS, curlFor, type Result } from '../_shared/forum.js';
import { go, impl, labFor, thread } from './model.js';

const dir = challengeDir(import.meta.url);
const view = (name: string): string => join(dir, 'views', `${name}.ejs`);

/** The real request as a Visit: the raw query; this lab has no cookies of its own. */
const visit = (req: Request, res: Response): Visit => visitOf(req, res, []);

/** A value shown back to the player: at most the URL cap (the simulated browser refuses longer URLs anyway). */
const SHOWN = 2048;

export const FP08 = register(defineChallenge({
  id: 'FP-08', district: 'forum-of-pilgrims', slug: 'open-redirect', dir,
  title: { id: 'Open Redirect (tautan berbagi)', en: 'Open Redirect (share link)' },
  summary: {
    id: 'Buat tautan berbagi forum yang membawa peramban admin ke servermu. Buktinya: kunjungan admin tiba di servermu melalui tautan berbagi.',
    en: 'Craft a forum share link that carries the admin\'s browser to your server. The proof is the admin\'s visit arriving at your server through the share link.',
  },
  maps: ['A01:2025', 'CWE-601'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Parameter "next" memutuskan ke mana peramban pergi setelahnya.', en: 'The "next" parameter decides where the browser goes afterward.' } },
    { id: 2, cost: 20, text: { id: '"Dimulai dengan garis miring" tidak berarti "tetap di situs ini".', en: '"Starts with a slash" doesn\'t mean "stays on this site".' } },
    { id: 3, cost: 40, text: { id: 'Mencocokkan nama host dengan "mengandung" bisa ditipu oleh subdomain.', en: 'Matching a hostname by "contains" can be fooled by a subdomain.' } },
  ],
  victim: {
    sim: (req) => labFor(req).world,
    actions: [
      {
        name: 'send-link',
        label: VICTIM_LABELS.sendLink,
        description: { id: 'membuka tautan berbagi apa pun yang Anda kirim', en: 'opens any share link you send' },
        input: 'url',
        // The admin has no standing state to restore (nobody is signed in), so there is nothing to re-arm.
        // Custom (not the preset) because the proof needs the visit's trace: the admin must really ARRIVE at your server,
        // and by way of a redirect from the lab (a direct link to your server, or a chain the browser gives up on, proves nothing).
        run: (req, { url }) => {
          const state = labFor(req);
          const visit = state.admin.follow(url);
          if (visit.outcome === 'attacker' && visit.hops.at(-1)?.via === 'redirect') state.escaped = true;
        },
      },
    ],
  },
  mount: (router) => {
    const home = (req: Request, res: Response, result: Result | null, next: string) => {
      const proven = labFor(req).escaped && req.level !== 'divine';
      const outcome: Result = proven
        ? { ok: true, text: `The admin's browser left the forum through your share link and arrived at your server. Flag: ${flagFor(req, FP08)}` }
        : { ok: false, text: 'Nothing has reached your server through a share link yet.' };
      const shown = next.slice(0, SHOWN);
      return sendPage(res, view('home'), {
        base: labPath(res), target: ADMIN_NAME, threads: THREADS, result, next: shown, outcome,
        shareLink: shown === '' ? '' : `http://citadel.test/go?next=${encodeURIComponent(shown)}`,
        tryHref: shown === '' ? '' : `${labPath(res)}/go?next=${encodeURIComponent(shown)}&level=${req.level}`,
        curl: curlFor(req, res, { path: '', form: { next: '/thread/1' }, signIn: false }),
      });
    };

    router.get('/', (req, res) => home(req, res, null, ''));

    router.post('/', (req, res) => {
      const next = field(req, 'next');
      const result: Result = next === ''
        ? { ok: false, text: 'Enter where the share link should continue to.' }
        : { ok: true, text: `Share link: http://citadel.test/go?next=${encodeURIComponent(next.slice(0, SHOWN))}` };
      return home(req, res, result, next);
    });

    // The twin of http://citadel.test/go, in the player's own browser. Every Location a level made goes through
    // sendReply, i.e. sendSimRedirect: never res.redirect() to a next.
    router.get('/go', (req, res) => {
      const r = go(visit(req, res));
      return sendReply(res, r, () => sendPage(res, view('go'), { base: labPath(res), text: r.text }));
    });

    // The twin of http://citadel.test/thread/<id>: where a local `next` lands.
    router.get('/thread/:id', (req, res) => {
      const r = thread(typeof req.params.id === 'string' ? req.params.id : '');
      return sendReply(res, r, () => sendPage(res, view('thread'), { base: labPath(res), id: req.params.id, heading: r.title ?? '', text: r.text, found: r.title !== undefined }));
    });
  },
}));
