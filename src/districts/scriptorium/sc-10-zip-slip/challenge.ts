// challenge.ts — SC-10 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { field, labPath, tryDb } from '../../../core/lab.js';
import { flagFor } from '../../../core/mount.js';
import { defineChallenge, register } from '../../../core/registry.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { SIMFS_LIMITS, simInterpret } from '../../../core/simfs.js';
import { readZip } from '../../../core/upload-zip.js';
import { mountUpload, receive, uploadCurl, visible, type Result } from '../_shared/lab.js';
import { RESTORE_DIR, SENTINEL, impl, labFor, resetLab } from './model.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'restore.ejs');

/** One line of the extraction report. */
interface Line { readonly ok: boolean; readonly text: string }

/** The welcome page: the sentinel template, run by the simulated interpreter (the flag only if it holds the statement). */
function welcomeText(req: Request): string {
  const file = labFor(req).fs.read(SENTINEL);
  if (file === undefined) return '';
  const printed = simInterpret(file.bytes, () => flagFor(req, SC10));
  return (printed ?? file.bytes.toString('utf8')).slice(0, 2000);
}

const show = (req: Request, res: Response, result: Result | null, lines: readonly Line[] = [], caption = '') => sendPage(res, view, {
  base: labPath(res), result, lines, caption, restoreDir: RESTORE_DIR, sentinel: SENTINEL,
  welcome: welcomeText(req),
  files: labFor(req).fs.list(RESTORE_DIR).map((f) => visible(f.path)),
  upload: uploadCurl(req, res, 'archive'),
});

export const SC10 = register(defineChallenge({
  id: 'SC-10', district: 'scriptorium', slug: 'zip-slip', dir,
  title: { id: 'ZIP slip', en: 'ZIP Slip' },
  summary: {
    id: 'Skriptorium memulihkan ruang kerjamu dari arsip .zip dan mengekstraknya ke folder pemulihan. Buat nama sebuah berkas di dalam arsip menunjuk keluar dari folder itu, timpa templat sambutan, lalu baca bendera yang dicetaknya.',
    en: 'The Scriptorium restores your workspace from a .zip archive, extracting it into a restore folder. Make a file name inside the archive point out of that folder, overwrite the welcome template, then read the flag it prints.',
  },
  maps: ['A01:2025', 'CWE-22', 'CWE-23'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Nama setiap berkas di dalam arsip bisa menunjuk ke mana saja. Siapa yang menulis nama itu, dan ke mana server menyambungkannya?', en: 'Each file\'s name inside the archive can point anywhere. Who writes that name, and where does the server join it?' } },
    { id: 2, cost: 20, text: { id: 'Menghapus satu `../` tidak menghapus yang tersembunyi di dalamnya. Apa yang tersisa setelah penyaring bekerja sekali saja?', en: 'Removing one `../` doesn\'t remove the one hidden inside it. What is left once a filter has run just once?' } },
    { id: 3, cost: 40, text: { id: 'Tidak semua sistem menulis pemisah jalur yang sama. Dan apa yang terjadi pada sambungan jalur bila bagian kedua dimulai dari akar?', en: 'Not every system writes the same path separator. And what happens to a path join when its second part starts at the root?' } },
  ],
  reset: (req) => { resetLab(req); },
  mount: (router) => {
    router.get('/', (req, res) => show(req, res, null));

    mountUpload(router, async (req, res) => {
      const caption = field(req, 'caption');
      // The archive is not stored, only its entries: the engine's default per-file cap (512 KiB) applies.
      const got = await receive(req, 'archive');
      if (!got.ok) return show(req, res, { ok: false, text: got.text }, [], caption);
      const keep = got.fields.caption ?? '';
      if (got.file === undefined) return show(req, res, { ok: false, text: 'Choose an archive to restore.' }, [], keep);
      const bytes = got.file.bytes;
      // The entries may inflate to at most what the simulated file system holds: a bigger archive is refused as an archive.
      const entries = tryDb(req, () => readZip(bytes, { totalBytes: SIMFS_LIMITS.totalBytes }), 'Archive error');
      if (!entries.ok) return show(req, res, { ok: false, text: entries.message }, [], keep);
      const fs = labFor(req).fs;
      const level = impl.for(req.level);
      const lines: Line[] = [];
      for (const e of entries.value) {
        if (e.directory) continue; // a folder entry holds no bytes: the simulated file system has no empty directories
        const name = visible(e.name);
        const r = tryDb(req, () => level.extract(fs, RESTORE_DIR, e), 'Storage error'); // the level's join
        if (!r.ok) lines.push({ ok: false, text: `Skipped ${name}: ${r.message}` });
        else if (!r.value.ok) lines.push({ ok: false, text: `Skipped ${name}: ${r.value.text}` });
        else lines.push({ ok: true, text: `Restored ${name} to ${visible(r.value.path)}` });
      }
      const done = lines.filter((l) => l.ok).length;
      return show(req, res, { ok: done > 0, text: `Restored ${done} of ${lines.length} entries.` }, lines, keep);
    }, (req, res) => show(req, res, { ok: false, text: 'The archive is too large (at most 2 MiB).' }));
  },
}));
