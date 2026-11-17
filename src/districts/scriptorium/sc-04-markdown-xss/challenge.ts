// challenge.ts — SC-04 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { field, labPath } from '../../../core/lab.js';
import { defineChallenge, register } from '../../../core/registry.js';
import { sendPage } from '../../../core/render.js';
import { sendLinkAction } from '../../../core/sim.js';
import { challengeDir } from '../../../core/source.js';
import { previewFrame } from '../../../core/xss.js';
import type { Result } from '../../_shared/result.js';
import { keySignIn, proofView, rearmVictim } from '../../_shared/xss-lab.js';
import { NOTE_LENGTH, SESSION, impl, labFor, renderMarkdown } from './model.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'note.ejs');
const LIBRARIAN = 'the librarian';

/** The note editor in the player's own browser: the note escaped in the chrome, rendered raw only inside the preview. */
function show(req: Request, res: Response, result: Result | null, key: string) {
  const lab = labFor(req);
  const raw = typeof req.query.md === 'string' ? req.query.md : '';
  const md = raw.slice(0, NOTE_LENGTH); // what a link can carry; a longer note never reaches the librarian
  return sendPage(res, view, {
    base: labPath(res), md,
    shareLink: md === '' ? '' : `http://citadel.test/note?md=${encodeURIComponent(md)}`,
    // The only raw output: the level's rendering of the note, inside the sandboxed preview frame.
    preview: md === '' ? '' : previewFrame(renderMarkdown(req.level, md), { marker: lab.marker.call, title: 'Note preview' }),
    proof: proofView(lab, LIBRARIAN, key, result),
  });
}

export const SC04 = register(defineChallenge({
  id: 'SC-04', district: 'scriptorium', slug: 'markdown-xss', dir,
  title: { id: 'XSS pada perender Markdown', en: 'Markdown renderer XSS' },
  summary: {
    id: 'Catatan Skriptorium ditulis dalam Markdown dan dibagikan lewat tautan. Tulis catatan yang perendernya ubah menjadi HTML yang menjalankan skrip Anda di peramban pustakawan, lalu masuklah dengan sesi pustakawan yang dikirim skrip itu ke server Anda.',
    en: 'Scriptorium notes are written in Markdown and shared by link. Write a note that the renderer turns into HTML that runs your script in the librarian\'s browser, then sign in with the librarian\'s session that script sends to your server.',
  },
  maps: ['A05:2025', 'CWE-79'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Markdown menjadi HTML — apa yang terjadi pada HTML yang sudah Anda tulis?', en: 'Markdown becomes HTML — what happens to HTML you already wrote?' } },
    { id: 2, cost: 20, text: { id: 'Tautan punya target; tidak semua skema target aman.', en: 'Links have a target; not every target scheme is safe.' } },
    { id: 3, cost: 40, text: { id: 'Judul atau sumber sebuah gambar bisa mendarat di dalam sebuah atribut.', en: 'An image\'s title or source can land inside an attribute.' } },
  ],
  victim: {
    sim: (req) => labFor(req).world,
    actions: [sendLinkAction((req) => labFor(req).admin, {
      // The librarian's standing state is being signed in: restored before every link (a /logout link cannot wedge the lab).
      rearm: rearmVictim(SESSION, labFor),
      description: { id: 'membuka tautan catatan yang Anda kirim, dalam keadaan masuk', en: 'opens the note link you send, while signed in' },
    })],
  },
  mount: (router) => {
    // The twins of http://citadel.test/ and /note: the same note page, the same fragment.
    router.get('/', (req, res) => show(req, res, null, ''));
    router.get('/note', (req, res) => show(req, res, null, ''));
    // The proof: sign in with the session key your server received.
    router.post('/', (req, res) => {
      const key = field(req, 'key');
      return show(req, res, keySignIn(req, SC04, key, labFor(req), LIBRARIAN), key);
    });
  },
}));
