// challenge.ts — SC-02 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { field, labPath } from '../../../core/lab.js';
import { defineChallenge, register } from '../../../core/registry.js';
import { sendPage } from '../../../core/render.js';
import { CITADEL_ORIGIN } from '../../../core/sim.js';
import { challengeDir } from '../../../core/source.js';
import { previewFrame } from '../../../core/xss.js';
import { curlFor } from '../../_shared/curl.js';
import type { Result } from '../../_shared/result.js';
import { keySignIn, proofView, rearmVictim } from '../../_shared/xss-lab.js';
import { SCROLL, SESSION, addReview, impl, labFor, resetLab, reviewById } from './model.js';

const dir = challengeDir(import.meta.url);
const view = (name: string): string => join(dir, 'views', `${name}.ejs`);
const MODERATOR = 'the moderator';
const rearm = rearmVictim(SESSION, labFor);

/** What a front-page answer carries: the review form's message and draft, the sign-in's message and key. */
interface Shown { readonly posted?: Result; readonly draft?: string; readonly signedIn?: Result; readonly key?: string }

/** The scroll page in the player's own browser: every review as written (escaped), the newest one live in the preview. */
function show(req: Request, res: Response, s: Shown) {
  const lab = labFor(req);
  const newest = lab.reviews.at(-1);
  return sendPage(res, view('scroll'), {
    base: labPath(res), scroll: SCROLL,
    reviews: [...lab.reviews].reverse(),
    // The only raw output: the level's rendering of the newest review, inside the sandboxed preview frame.
    preview: newest === undefined ? '' : previewFrame(impl.for(req.level).renderReview(newest.body), { marker: lab.marker.call, title: 'Newest review preview' }),
    newest: newest?.id ?? null,
    posted: s.posted ?? null, draft: s.draft ?? '',
    proof: proofView(lab, MODERATOR, s.key ?? '', s.signedIn ?? null),
    curl: curlFor(req, res, { path: '', form: { intent: 'review', review: '<your review>' }, signIn: false }),
  });
}

export const SC02 = register(defineChallenge({
  id: 'SC-02', district: 'scriptorium', slug: 'stored-xss', dir,
  title: { id: 'XSS Tersimpan (ulasan)', en: 'Stored XSS (review)' },
  summary: {
    id: 'Ulasan sebuah gulungan disimpan dan kemudian dibaca moderator. Tulis ulasan yang menjalankan skrip Anda di peramban moderator saat ia membacanya, lalu masuklah dengan sesi moderator yang dikirim skrip itu ke server Anda.',
    en: 'Reviews of a scroll are stored and read later by the moderator. Write a review that runs your script in the moderator\'s browser when they read it, then sign in with the moderator\'s session that script sends to your server.',
  },
  maps: ['A05:2025', 'CWE-79'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Ulasan Anda bertahan dan dibaca orang lain nanti.', en: 'Your review persists and someone reads it later.' } },
    { id: 2, cost: 20, text: { id: 'Pemblokiran berbasis kata hanya menutup ejaan yang terpikirkan penulisnya.', en: 'Word-based blocking only closes the spellings the author imagined.' } },
    { id: 3, cost: 40, text: { id: 'Membuang tag tanpa membaca ulang pohon HTML meninggalkan atribut hidup.', en: 'Stripping tags without re-reading the HTML tree leaves attributes alive.' } },
  ],
  // A stored review can wedge the page you test it on; the lab has no limiter, so Restart is safe (RECIPES section 4).
  reset: (req) => { resetLab(req); },
  victim: {
    sim: (req) => labFor(req).world,
    actions: [{
      name: 'read-review',
      label: { id: 'Minta moderator membaca ulasan terbaru', en: 'Ask the moderator to read the newest review' },
      description: { id: 'membuka halaman gulungan, lalu ulasan terbaru di sana, dalam keadaan masuk', en: 'opens the scroll page, then the newest review on it, while signed in' },
      run: (req) => {
        const lab = labFor(req);
        rearm(req, lab.admin); // signed in again, whatever happened before
        const newest = lab.reviews.at(-1);
        if (newest === undefined) return { id: 'Belum ada ulasan untuk dibaca.', en: 'There is no review to read yet.' };
        const scroll = `${CITADEL_ORIGIN}/scroll`;
        lab.admin.follow(scroll);
        lab.admin.follow(`${CITADEL_ORIGIN}/review/${newest.id}`, { referrer: scroll }); // a click on the scroll page
      },
    }],
  },
  mount: (router) => {
    // The twins of http://citadel.test/ and /scroll: the scroll and its reviews.
    router.get('/', (req, res) => show(req, res, {}));
    router.get('/scroll', (req, res) => show(req, res, {}));
    // One form posts a review (intent=review); the other signs in with a session key (the default).
    router.post('/', (req, res) => {
      if (field(req, 'intent') === 'review') {
        const draft = field(req, 'review');
        return show(req, res, { posted: addReview(labFor(req), draft), draft });
      }
      const key = field(req, 'key');
      return show(req, res, { signedIn: keySignIn(req, SC02, key, labFor(req), MODERATOR), key });
    });
    // The twin of http://citadel.test/review/<id>: that review, live in the preview.
    router.get('/review/:id', async (req, res) => {
      const lab = labFor(req);
      const review = reviewById(lab, typeof req.params.id === 'string' ? req.params.id : '');
      if (review === undefined) res.status(404);
      await sendPage(res, view('review'), {
        base: labPath(res), scroll: SCROLL, review: review ?? null,
        preview: review === undefined ? '' : previewFrame(impl.for(req.level).renderReview(review.body), { marker: lab.marker.call, title: `Review #${review.id} preview` }),
      });
    });
  },
}));
