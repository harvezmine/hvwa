// src/districts/scriptorium/_shared/desk.ts — the Scroll Desk shell of the upload-filter labs (SC-07, SC-08, SC-09): one
// uploader page, an upload route, a simulated archive server at GET uploads?name=..., and (opt-in) a raster-only
// preview at GET preview?name=... The shell holds NO policy: whether an upload is refused, under which name and with
// which bytes it is stored, which stored name the server finds and whether it hands that file to the interpreter are
// the level's decisions (`DeskLevel`, in each lab's levels/*.ts), so View Source and the Diff show the whole flaw.
// Nothing uploaded ever executes (owner decision Q7): "running" a file is simInterpret, which prints the flag only for
// the one statement `<?hvwa CANARY ?>`. Uploaded bytes reach the player's real browser only as an inert download, or
// (preview) as a raster image of the type its own header names.
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response, Router } from 'express';
import { field, labPath, tryDb } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { flagFor } from '../../../core/mount.js';
import type { Challenge } from '../../../core/registry.js';
import { sendPage } from '../../../core/render.js';
import { SIMFS_LIMITS, simFs, simInterpret, type SimFile, type SimFs, type SimSeparators } from '../../../core/simfs.js';
import { placeholderImage, sniffImage, type UploadedFile } from '../../../core/upload.js';
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

/** The pinned file a desk starts with, under UPLOADS_DIR. */
export interface DeskSeed {
  readonly name: string;
  readonly bytes: Uint8Array | string;
  readonly contentType: string;
}

export interface NewDeskOptions {
  /** Default: README.txt holding 'Scrolls go here.\n' (text/plain). */
  readonly seed?: DeskSeed;
  /** The simulated OS's separators (simFs): '/' (default) or '/\\' for a Windows-style server. */
  readonly separators?: SimSeparators;
}

const README: DeskSeed = { name: 'README.txt', bytes: 'Scrolls go here.\n', contentType: 'text/plain' };

/** A fresh desk with its seed pinned. Call it inside the lab's perSession factory (simFs throws anywhere else). */
export function newDesk(opts: NewDeskOptions = {}): DeskState {
  const fs = simFs({ separators: opts.separators ?? '/' });
  const seed = opts.seed ?? README;
  fs.write(`${UPLOADS_DIR}/${seed.name}`, seed.bytes, { contentType: seed.contentType, pinned: true });
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
  /**
   * The lab's own view partial (an absolute .ejs path), drawn under the message. It sees the desk's view data and
   * `extra`. Plumbing and display only, like the rest of the page: never a filter or a decision.
   */
  readonly partial?: string;
  /** The partial's own data, under the one view key `extra` (so it never collides with the desk's or the engine's keys). */
  readonly extra?: (req: Request, res: Response) => Readonly<Record<string, unknown>>;
  /** Show the note on the simulated server's one statement, `<?hvwa CANARY ?>`. Default true (a server that runs files). */
  readonly statementNote?: boolean;
  /**
   * Mount GET /preview and show each stored raster image on the page in a fixed CSS box (SC-09). Default false.
   * The route serves only a file whose bytes start like a PNG, JPEG, GIF or WebP, as the type that header names
   * (never the uploader's claim), with nosniff and a CSP sandbox; at Divine it sends placeholderImage of the sniffed
   * size instead of the stored bytes. A raster with that type and nosniff never runs script in a browser.
   */
  readonly preview?: boolean;
}

const view = fileURLToPath(new URL('./views/desk.ejs', import.meta.url));

/** The fixed box every preview image is drawn in: never the image's own size (a header may declare 65535 x 65535). */
export const PREVIEW_BOX = 'width: 8rem; height: 8rem; object-fit: contain';

/** Mount GET / (the desk), POST / (an upload), GET /uploads (the simulated archive server) and, opt-in, GET /preview. */
export function mountDesk(router: Router, o: DeskOptions): void {
  if (o.partial !== undefined && (!isAbsolute(o.partial) || !o.partial.endsWith('.ejs'))) {
    throw new Error(`mountDesk: partial must be an absolute .ejs path (got "${o.partial}")`);
  }
  // EJS resolves an include against the including view: the partial's path relative to desk.ejs, with forward slashes.
  const partial = o.partial === undefined ? '' : relative(dirname(view), o.partial).split(sep).join('/');
  const preview = o.preview === true;

  const show = (req: Request, res: Response, result: Result | null, caption = '') => sendPage(res, view, {
    heading: o.heading, blurb: o.blurb, base: labPath(res), result, caption,
    files: o.labFor(req).fs.list(UPLOADS_DIR).map((f) => ({
      shown: visible(f.path), href: encodeURIComponent(f.path.slice(UPLOADS_DIR.length + 1)),
      preview: preview && sniffImage(f.bytes) !== null,
    })),
    curl: uploadCurl(req, res, 'scroll'),
    partial, extra: o.extra?.(req, res) ?? {}, statementNote: o.statementNote ?? true, previewBox: PREVIEW_BOX,
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

  if (preview) {
    router.get('/preview', (req, res) => {
      const name = typeof req.query.name === 'string' ? req.query.name : '';
      // The level's own lookup (as GET /uploads), but nothing is ever run here.
      const file = o.levels.for(req.level).serve(o.labFor(req).fs, name).file;
      const sniff = file === undefined ? null : sniffImage(file.bytes);
      res.set({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' });
      if (file === undefined || sniff === null) return res.status(404).type('text/plain').send('No such image.');
      // The server chooses the type (the header's), never the uploader's claim. At Divine, not even the bytes are the
      // player's: the secure reference shows only what the server made (a constant 35 bytes, never sized by pixels).
      return res.type(sniff.mime).send(req.level === 'divine' ? placeholderImage(sniff) : file.bytes);
    });
  }
}
