// challenge.ts — SC-01 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { setLabHeaders } from '../../../core/http.js';
import { field, labPath } from '../../../core/lab.js';
import { defineChallenge, register } from '../../../core/registry.js';
import { sendPage } from '../../../core/render.js';
import { sendLinkAction } from '../../../core/sim.js';
import { challengeDir } from '../../../core/source.js';
import { previewFrame } from '../../../core/xss.js';
import type { Result } from '../../_shared/result.js';
import { keySignIn, proofView, rearmVictim } from '../../_shared/xss-lab.js';
import { SESSION, impl, labFor } from './model.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'search.ejs');
const LIBRARIAN = 'the librarian';
/** The query as the page shows it back: at most the sim's URL cap (a longer link never reaches the librarian anyway). */
const SHOWN = 2048;

/** The search page in the player's own browser: the query escaped in the chrome, raw only inside the preview frame. */
function show(req: Request, res: Response, result: Result | null, key: string) {
  const lab = labFor(req);
  const level = impl.for(req.level);
  const raw = typeof req.query.q === 'string' ? req.query.q : '';
  const q = raw.slice(0, SHOWN);
  setLabHeaders(res, level.headers ?? {}); // the level's own headers, on this route only (Divine: its CSP)
  return sendPage(res, view, {
    base: labPath(res), q,
    shareLink: q === '' ? '' : `http://citadel.test/search?q=${encodeURIComponent(q)}`,
    // The only raw output: the level's fragment, inside the sandboxed preview frame.
    preview: q === '' ? '' : previewFrame(level.results(q), { marker: lab.marker.call, title: 'Search results preview' }),
    proof: proofView(lab, LIBRARIAN, key, result),
  });
}

export const SC01 = register(defineChallenge({
  id: 'SC-01', district: 'scriptorium', slug: 'reflected-xss', dir,
  title: { id: 'XSS Reflected (pencarian)', en: 'Reflected XSS (search)' },
  summary: {
    id: 'Pencarian Skriptorium menampilkan kembali kata yang Anda cari. Kirimi pustakawan sebuah tautan pencarian yang hasilnya menjalankan skrip Anda di perambannya, lalu masuklah dengan sesi pustakawan yang dikirim skrip itu ke server Anda.',
    en: 'The Scriptorium search echoes the words you search for. Send the librarian a search link whose results run your script in their browser, then sign in with the librarian\'s session that script sends to your server.',
  },
  maps: ['A05:2025', 'CWE-79'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Hasil pencarian menampilkan kembali kata Anda — persis seperti apa?', en: 'The results echo your words — echoed how, exactly?' } },
    { id: 2, cost: 20, text: { id: 'Satu konteks HTML tidak membutuhkan tanda kurung sudut sama sekali.', en: 'One HTML context needs no angle brackets at all.' } },
    { id: 3, cost: 40, text: { id: 'Jika tag disaring, atribut kejadian sebuah elemen biasa bisa menggantikannya.', en: 'If tags are filtered, an ordinary element\'s event attribute can stand in.' } },
  ],
  victim: {
    sim: (req) => labFor(req).world,
    actions: [sendLinkAction((req) => labFor(req).admin, {
      // The librarian's standing state is being signed in: restored before every link (a /logout link cannot wedge the lab).
      rearm: rearmVictim(SESSION, labFor),
      description: { id: 'membuka tautan pencarian yang Anda kirim, dalam keadaan masuk', en: 'opens the search link you send, while signed in' },
    })],
  },
  mount: (router) => {
    // The twins of http://citadel.test/ and /search: the same search page, the same fragment.
    router.get('/', (req, res) => show(req, res, null, ''));
    router.get('/search', (req, res) => show(req, res, null, ''));
    // The proof: sign in with the session key your server received.
    router.post('/', (req, res) => {
      const key = field(req, 'key');
      return show(req, res, keySignIn(req, SC01, key, labFor(req), LIBRARIAN), key);
    });
  },
}));
