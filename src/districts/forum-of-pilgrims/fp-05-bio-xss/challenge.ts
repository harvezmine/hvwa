// challenge.ts — FP-05 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { field, labPath } from '../../../core/lab.js';
import { defineChallenge, register } from '../../../core/registry.js';
import { sendPage } from '../../../core/render.js';
import { CITADEL_ORIGIN } from '../../../core/sim.js';
import { challengeDir } from '../../../core/source.js';
import { previewFrame } from '../../../core/xss.js';
import { keySignIn, proofView, rearmVictim } from '../../_shared/xss-lab.js';
import { ADMIN_NAME, PLAYER, curlFor, type Result } from '../_shared/forum.js';
import { SESSION, bioOf, impl, labFor, resetLab, saveBio } from './model.js';

const dir = challengeDir(import.meta.url);
const view = (name: string): string => join(dir, 'views', `${name}.ejs`);
const MODERATOR = 'the moderator';
const rearm = rearmVictim(SESSION, labFor);

/** What a front-page answer carries: the bio form's message and draft, the sign-in's message and key. */
interface Shown { readonly saved?: Result; readonly draft?: string; readonly signedIn?: Result; readonly key?: string }

/** The profile editor in the player's own browser: the bio escaped in its field, rendered raw only in the preview. */
function show(req: Request, res: Response, s: Shown) {
  const lab = labFor(req);
  return sendPage(res, view('editor'), {
    base: labPath(res), me: PLAYER.username, moderator: ADMIN_NAME,
    draft: s.draft ?? lab.bio, saved: s.saved ?? null,
    // The only raw output: the level's rendering of the saved bio, inside the sandboxed preview frame.
    preview: lab.bio === '' ? '' : previewFrame(impl.for(req.level).renderBio(lab.bio), { marker: lab.marker.call, title: 'Profile card preview' }),
    proof: proofView(lab, MODERATOR, s.key ?? '', s.signedIn ?? null),
    curl: curlFor(req, res, { path: '', form: { intent: 'bio', bio: '<your bio>' }, signIn: false }),
  });
}

export const FP05 = register(defineChallenge({
  id: 'FP-05', district: 'forum-of-pilgrims', slug: 'bio-xss', dir,
  title: { id: 'XSS Tersimpan (bio)', en: 'Stored XSS (bio)' },
  summary: {
    id: 'Bio Anda tampil di profil publik Anda di forum, dan moderator meninjaunya bila diminta. Simpan bio yang menjalankan skrip Anda di peramban moderator saat ia membuka profil Anda, lalu masuklah dengan sesi moderator yang dikirim skrip itu ke server Anda.',
    en: 'Your bio shows on your public forum profile, and the moderator reviews it when asked. Save a bio that runs your script in the moderator\'s browser when they open your profile, then sign in with the moderator\'s session that script sends to your server.',
  },
  maps: ['A05:2025', 'CWE-79'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Bio Anda ditampilkan di profil yang dilihat orang lain.', en: 'Your bio shows on a profile others view.' } },
    { id: 2, cost: 20, text: { id: 'Teks yang aman di satu tempat HTML bisa berbahaya di tempat lain.', en: 'Text that\'s safe in one HTML place can be dangerous in another.' } },
    { id: 3, cost: 40, text: { id: 'Mengizinkan beberapa tag tetap berarti memeriksa atributnya.', en: 'Allowing a few tags still means checking their attributes.' } },
  ],
  // A stored bio can wedge the page you test it on; the lab has no limiter, so Restart is safe (RECIPES section 4).
  reset: (req) => { resetLab(req); },
  victim: {
    sim: (req) => labFor(req).world,
    actions: [{
      name: 'view-profile',
      label: { id: 'Minta moderator meninjau profil Anda', en: 'Ask the moderator to review your profile' },
      description: { id: 'membuka profil publik Anda, dalam keadaan masuk', en: 'opens your public profile, while signed in' },
      run: (req) => {
        const lab = labFor(req);
        rearm(req, lab.admin); // signed in again, whatever happened before
        lab.admin.follow(`${CITADEL_ORIGIN}/u/${PLAYER.username}`); // typed in directly: no Referer
      },
    }],
  },
  mount: (router) => {
    router.get('/', (req, res) => show(req, res, {}));
    // One form saves the bio (intent=bio); the other signs in with a session key (the default).
    router.post('/', (req, res) => {
      if (field(req, 'intent') === 'bio') {
        const draft = field(req, 'bio');
        return show(req, res, { saved: saveBio(labFor(req), draft), draft });
      }
      const key = field(req, 'key');
      return show(req, res, { signedIn: keySignIn(req, FP05, key, labFor(req), MODERATOR), key });
    });
    // The twin of http://citadel.test/u/<name>: a member's public profile, the card live in the preview.
    router.get('/u/:name', async (req, res) => {
      const lab = labFor(req);
      const name = typeof req.params.name === 'string' ? req.params.name : '';
      const bio = bioOf(lab, name);
      if (bio === undefined) res.status(404);
      await sendPage(res, view('profile'), {
        base: labPath(res), name, found: bio !== undefined,
        preview: bio === undefined ? '' : previewFrame(impl.for(req.level).renderBio(bio), { marker: lab.marker.call, title: `Profile of ${name}` }),
      });
    });
  },
}));
