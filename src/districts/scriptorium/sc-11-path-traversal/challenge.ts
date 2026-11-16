// challenge.ts — SC-11 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { field, labPath, tryDb } from '../../../core/lab.js';
import { defineChallenge, register } from '../../../core/registry.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import type { SimFile } from '../../../core/simfs.js';
import { curlFor } from '../../_shared/curl.js';
import type { Result } from '../../_shared/result.js';
import { SCROLLS, impl, labFor } from './model.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'library.ejs');

/** What a lookup came to: the file, a refusal, an error, or a miss. */
type Lookup =
  | { readonly kind: 'file'; readonly file: SimFile }
  | { readonly kind: 'refused' | 'error'; readonly text: string }
  | { readonly kind: 'missing' };

/** Ask the level for `name`: only its own call is inside tryDb (the real message below Divine, a generic one at Divine). */
function lookup(req: Request, name: string): Lookup {
  const fs = labFor(req).fs; // OUTSIDE tryDb: building the lab (issueFlag, the platform's 429) is not a download error
  const found = tryDb(req, () => impl.for(req.level).read(fs, name), 'Download error');
  if (!found.ok) return { kind: 'error', text: found.message };
  if (!found.value.ok) return { kind: 'refused', text: found.value.text };
  return found.value.file === undefined ? { kind: 'missing' } : { kind: 'file', file: found.value.file };
}

const show = (req: Request, res: Response, file: string, result: Result | null, contents: string | null = null) => sendPage(res, view, {
  base: labPath(res), scrolls: SCROLLS.map(([name]) => name), file, result, contents,
  curl: curlFor(req, res, { path: '', form: { file: '<scroll name>' }, signIn: false }),
});

export const SC11 = register(defineChallenge({
  id: 'SC-11', district: 'scriptorium', slug: 'path-traversal', dir,
  title: { id: 'Unduh dengan path traversal', en: 'Path Traversal Download' },
  summary: {
    id: 'Perpustakaan Skriptorium menyajikan gulungan publik lewat tautan unduh yang membawa nama berkas. Buat server membaca berkas di luar direktori publik, dan ambil bendera dari brankas arsip.',
    en: 'The Scriptorium library serves its public scrolls through a download link that carries a file name. Make the server read a file outside the public directory, and take the flag from the archive vault.',
  },
  maps: ['A01:2025', 'CWE-22', 'CWE-23'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Tautan unduh membawa nama berkas. Dari direktori mana server membacanya, dan apa yang terjadi bila nama itu menunjuk ke atas?', en: 'The download link carries a file name. Which directory does the server read it from, and what happens when the name points upward?' } },
    { id: 2, cost: 20, text: { id: 'Memfilter lalu men-dekode bukanlah hal yang sama dengan men-dekode lalu memfilter. Siapa yang sudah men-dekode namamu sebelum kode level melihatnya?', en: 'Filter-then-decode is not the same as decode-then-filter. Who has already decoded your name before the level\'s code sees it?' } },
    { id: 3, cost: 40, text: { id: 'Cara teraman tidak pernah membangun jalur dari masukan sama sekali. Apa yang bisa dilakukan penyaring bila masukannya sudah dua kali dibungkus?', en: 'The safest way never builds a path from input at all. What can a filter do about input that has been wrapped twice?' } },
  ],
  mount: (router) => {
    router.get('/', (req, res) => show(req, res, '', null));

    // The page's own form: the same lookup, the contents shown on the page (status 200: it is a form, like the other labs').
    router.post('/', (req, res) => {
      const name = field(req, 'file');
      if (name === '') return show(req, res, name, { ok: false, text: 'Choose a scroll to show.' });
      const r = lookup(req, name);
      if (r.kind === 'file') return show(req, res, name, { ok: true, text: `Showing ${name}.` }, r.file.bytes.toString('utf8').slice(0, 2000));
      return show(req, res, name, { ok: false, text: r.kind === 'missing' ? 'No such scroll.' : r.text });
    });

    // The download: GET <lab>/download?file=<name>. Plain text only, never an active type.
    router.get('/download', (req, res) => {
      const name = typeof req.query.file === 'string' ? req.query.file : '';
      const r = lookup(req, name);
      res.set({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' }).type('text/plain');
      if (r.kind === 'file') return res.send(r.file.bytes);
      if (r.kind === 'missing') return res.status(404).send('No such scroll.');
      return res.status(400).send(r.text);
    });
  },
}));
