// src/districts/scriptorium/_shared/desk.ts — the Scroll Desk shell of the upload-filter labs (SC-07, SC-08): one
// uploader page, an upload route and a simulated archive server at GET uploads?name=... The shell holds NO policy:
// whether an upload is refused, under which name it is stored, which stored name the server finds and whether it
// hands that file to the interpreter are the level's decisions (`DeskLevel`, in each lab's levels/*.ts), so View
// Source and the Diff show the whole flaw. Nothing uploaded ever executes (owner decision Q7): "running" a file is
// simInterpret, which prints the flag only for the one statement `<?hvwa CANARY ?>`.
import { fileURLToPath } from 'node:url';
import type { Request, Response, Router } from 'express';
import { field, labPath, tryDb } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { flagFor } from '../../../core/mount.js';
import type { Challenge } from '../../../core/registry.js';
import { sendPage } from '../../../core/render.js';
import { SIMFS_LIMITS, simFs, simInterpret, type SimFile, type SimFs } from '../../../core/simfs.js';
import type { UploadedFile } from '../../../core/upload.js';
import { mountUpload, receive, uploadCurl, visible, type Result } from './lab.js';

/** Where the simulated archive server keeps uploaded scrolls, and the root GET uploads?name=... looks names up under. */
export const UPLOADS_DIR = '/srv/uploads';

/** What `store` decides: the path the upload now lives at, or why it was refused. */
export type Stored = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly text: string };

/** What the simulated server finds for a requested name, and whether it hands the file to the interpreter. */
export interface Served {
  readonly file: SimFile | undefined;
  readonly runs: boolean;
}

/** What every levels/<level>.ts of a desk lab exports (checked by byLevel<DeskLevel>). */
export interface DeskLevel {
  /** Refuse the upload, or write it into the simulated file system (`fs.write`) and say where. The lab's filter. */
  store(fs: SimFs, file: UploadedFile): Stored;
  /** Look `name` up (the request's file name, decoded once by Express) and decide whether the server "runs" it. */
  serve(fs: SimFs, name: string): Served;
}

/** One player's desk at one level: the simulated archive server's files. */
export interface DeskState { readonly fs: SimFs }

/** A fresh desk. Call it inside the lab's perSession factory (simFs throws anywhere else). */
export function newDesk(): DeskState {
  const fs = simFs();
  fs.write(`${UPLOADS_DIR}/README.txt`, 'Scrolls go here.\n', { contentType: 'text/plain', pinned: true });
  return { fs };
}

export interface DeskOptions {
  /** The registered challenge, bound late (it is assigned after `mount` is declared). */
  readonly challenge: () => Pick<Challenge, 'id' | 'levels'>;
  readonly levels: { for(level: Level): DeskLevel };
  readonly labFor: (req: Pick<Request, 'sessionId' | 'level'>) => DeskState;
  /** The lab page's heading and the sentence under it (English: the vulnerable app's own words). */
  readonly heading: string;
  readonly blurb: string;
}

const view = fileURLToPath(new URL('./views/desk.ejs', import.meta.url));

/** Mount GET / (the desk), POST / (an upload) and GET /uploads (the simulated archive server). */
export function mountDesk(router: Router, o: DeskOptions): void {
  const show = (req: Request, res: Response, result: Result | null, caption = '') => sendPage(res, view, {
    heading: o.heading, blurb: o.blurb, base: labPath(res), result, caption,
    files: o.labFor(req).fs.list(UPLOADS_DIR).map((f) => ({
      shown: visible(f.path), href: encodeURIComponent(f.path.slice(UPLOADS_DIR.length + 1)),
    })),
    curl: uploadCurl(req, res, 'scroll'),
  });

  router.get('/', (req, res) => show(req, res, null));

  mountUpload(router, async (req, res) => {
    const got = await receive(req, 'scroll', { maxFileBytes: SIMFS_LIMITS.fileBytes });
    // A request that is not an upload (a plain form post, JSON) keeps whatever caption it carried.
    if (!got.ok) return show(req, res, { ok: false, text: got.text }, field(req, 'caption'));
    const caption = got.fields.caption ?? '';
    if (got.file === undefined) return show(req, res, { ok: false, text: 'Choose a scroll to upload.' }, caption);
    const file = got.file;
    const fs = o.labFor(req).fs; // OUTSIDE tryDb: building the lab (the platform's 429) is not a storage error
    const stored = tryDb(req, () => o.levels.for(req.level).store(fs, file), 'Storage error');
    if (!stored.ok) return show(req, res, { ok: false, text: stored.message }, caption);
    if (!stored.value.ok) return show(req, res, { ok: false, text: stored.value.text }, caption);
    return show(req, res, { ok: true, text: `Stored as ${visible(stored.value.path)}.` }, caption);
  }, (req, res) => show(req, res, { ok: false, text: 'The scroll is too large (at most 2 MiB).' }));

  router.get('/uploads', (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    const served = o.levels.for(req.level).serve(o.labFor(req).fs, name);
    if (served.file === undefined) {
      res.status(404);
      return show(req, res, { ok: false, text: 'No such scroll.' });
    }
    if (served.runs) {
      // NOTHING EXECUTES: the simulated interpreter pattern-matches its one statement; the flag only on a match.
      const printed = simInterpret(served.file.bytes, () => flagFor(req, o.challenge()));
      return show(req, res, { ok: true, text: `The server ran ${visible(served.file.path)}. It printed: ${printed ?? '(nothing)'}` });
    }
    // Never hand uploaded bytes to the player's real browser as an active type, whatever was claimed.
    res.set({
      'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'attachment', 'Content-Security-Policy': 'sandbox',
    }).send(served.file.bytes);
  });
}
