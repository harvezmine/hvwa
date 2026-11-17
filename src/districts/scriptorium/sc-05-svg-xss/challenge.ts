// challenge.ts — SC-05 metadata, the moderator (the simulated victim) and the real routes. The vulnerable code is in
// levels/*.ts (served by View Source); model.ts holds the lab state and the gallery the moderator's browser visits.
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { setLabHeaders } from '../../../core/http.js';
import { field, labPath, tryDb } from '../../../core/lab.js';
import { flagFor } from '../../../core/mount.js';
import { defineChallenge, register, type Text } from '../../../core/registry.js';
import { sendPage } from '../../../core/render.js';
import { CITADEL_ORIGIN, type SimBrowser } from '../../../core/sim.js';
import { challengeDir } from '../../../core/source.js';
import { previewFrame, rendersDocument, type XssPageVerdict } from '../../../core/xss.js';
import { mountUpload, receive, uploadCurl, type Result } from '../_shared/lab.js';
import { DOWNLOAD_HEADERS, DOWNLOAD_LAB_HEADERS, SESSION, SIGIL, SIGIL_MAX_BYTES, impl, labFor, resetLab } from './model.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'gallery.ejs');
/** How much of the stored sigil the lab page shows as source (escaped). */
const SOURCE_SHOWN = 2000;

interface Kept { readonly caption?: string; readonly session?: string }

const show = (req: Request, res: Response, result: Result | null, kept: Kept = {}) => {
  const lab = labFor(req);
  const file = lab.fs.read(SIGIL);
  let sigil = null;
  if (file !== undefined) {
    const text = file.bytes.toString('utf8');
    const review = impl.for(req.level).review(text); // what the gallery answers the moderator's GET /review
    const as = rendersDocument(review.headers) ?? null; // the moderator's browser's own rule (core/victim.ts)
    sigil = {
      bytes: file.bytes.length,
      source: text.slice(0, SOURCE_SHOWN),
      clipped: text.length > SOURCE_SHOWN,
      headers: Object.entries(review.headers).map(([k, v]) => `${k}: ${v}`),
      readAs: as,
      // The only raw output: the moderator's page, inside the sandboxed preview frame (opaque origin).
      preview: as === null ? '' : previewFrame(review.body, { marker: lab.marker.call, title: 'Moderator review preview' }),
    };
  }
  return sendPage(res, view, {
    base: labPath(res), result, caption: kept.caption ?? '', session: kept.session ?? '',
    marker: lab.marker.call, maxBytes: SIGIL_MAX_BYTES, sigil, curl: uploadCurl(req, res, 'sigil'),
  });
};

/** The moderator starts every review signed in to the gallery, whatever happened before. */
const rearm = (req: Request, moderator: SimBrowser): void => { moderator.cookies.set(SESSION, labFor(req).key); };

/** Why a payload did not run, when the visit summary cannot say it (the attacker log shows one that did). */
function reviewNote(v: XssPageVerdict | undefined): Text | undefined {
  if (v === undefined) return { id: 'Browser moderator tidak menampilkan apa pun: sigil diunduh.', en: 'The moderator\'s browser rendered nothing: the sigil was downloaded.' };
  if (v.fired) return undefined;
  if (v.page.limited !== undefined && v.page.limited !== 'time') {
    return { id: `Halaman tinjauan tidak dinilai (${v.page.limited}): tidak ada yang dihitung.`, en: `The review page was not judged (${v.page.limited}): nothing on it counts.` };
  }
  if (v.page.wellFormed === false) {
    return {
      id: 'Browser moderator membaca sigilmu sebagai dokumen XML dan mendapatinya tidak well-formed: hanya bagian sebelum galat pertama yang dihitung.',
      en: 'The moderator\'s browser read your sigil as an XML document and found it not well-formed: only what came before the first error counts.',
    };
  }
  if (v.page.reachedMarker) return { id: 'Penandamu sampai di halaman moderator, tetapi tidak ada yang menjalankannya.', en: 'Your marker reached the moderator\'s page, but nothing there ran it.' };
  return undefined;
}

export const SC05 = register(defineChallenge({
  id: 'SC-05', district: 'scriptorium', slug: 'svg-xss', dir,
  title: { id: 'XSS lewat unggahan SVG', en: 'SVG Upload XSS' },
  summary: {
    id: 'Galeri sigil Skriptorium menerima sigil SVG dari setiap peziarah, dan seorang moderator meninjau sigil baru sambil masuk ke galeri. Buat sigilmu menjalankan penandamu di browser moderator, curi sesi moderator dari log penyerangmu, lalu masuk dengan sesi itu.',
    en: 'The Scriptorium\'s sigil gallery takes an SVG sigil from every pilgrim, and a moderator reviews each new one while signed in. Make your sigil run your marker in the moderator\'s browser, steal the moderator\'s session from your attacker log, then sign in with it.',
  },
  maps: ['A05:2025', 'CWE-79', 'CWE-434'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'SVG bukan sekadar gambar; ia bisa berisi elemen aktif. Apa yang dilakukan halaman tinjauan dengan sigilmu sebelum moderator melihatnya?', en: 'An SVG is not just a picture; it can hold active elements. What does the review page do with your sigil before the moderator sees it?' } },
    { id: 2, cost: 20, text: { id: 'Memblokir satu tag tidak memblokir setiap cara sebuah elemen bereaksi. Daftar penangan peristiwa siapa yang dipakai penyaring, dan apakah SVG punya peristiwa yang tidak ada di daftar itu?', en: 'Blocking one tag doesn\'t block every way an element reacts. Whose list of event handlers does the filter use, and does SVG have events that list never names?' } },
    { id: 3, cost: 40, text: { id: 'Cara server menyajikan berkas menentukan apakah browser menampilkannya sebaris. Apa yang terjadi bila sebuah SVG dibuka langsung, bukan lewat tag gambar, dan apa yang harus benar agar browser mau membacanya?', en: 'How the server serves the file decides whether the browser shows it inline. What happens when an SVG is opened directly rather than through an image tag, and what must be right for the browser to read it at all?' } },
  ],
  reset: (req) => { resetLab(req); },
  victim: {
    sim: (req) => labFor(req).world,
    actions: [{
      name: 'review',
      label: { id: 'Minta moderator meninjau sigilmu', en: 'Ask the moderator to review your sigil' },
      description: {
        id: 'membuka tinjauan sigilmu (/review) di galeri, sebagai moderator yang sedang masuk',
        en: 'opens the review of your sigil (/review) in the gallery, signed in as the moderator',
      },
      run: (req) => {
        const lab = labFor(req);
        rearm(req, lab.moderator);
        if (lab.fs.read(SIGIL) === undefined) return { id: 'Belum ada sigil untuk ditinjau.', en: 'There is no sigil to review yet.' };
        const before = lab.moderator.verdicts.at(-1);
        lab.moderator.follow(`${CITADEL_ORIGIN}/review`);
        const after = lab.moderator.verdicts.at(-1);
        return reviewNote(after === before ? undefined : after);
      },
    }],
  },
  mount: (router) => {
    router.get('/', (req, res) => show(req, res, null));

    /** The last step of the attack: sign in to the gallery with the moderator's stolen session. */
    const signIn = (req: Request, res: Response) => {
      const session = field(req, 'session');
      const ok = session !== '' && session === labFor(req).key;
      // flagFor outside any tryDb; Divine never issues one (and no payload ever reaches its moderator's session).
      const text = !ok ? 'Wrong session key.' : req.level === 'divine' ? 'Signed in as the moderator.' : `Signed in as the moderator. Flag: ${flagFor(req, SC05)}`;
      return show(req, res, { ok, text }, { session });
    };

    mountUpload(router, async (req, res) => {
      // The sign-in form posts here too (a form has no action): a urlencoded post whose intent is sign-in.
      if (!Buffer.isBuffer(req.body) && field(req, 'intent') === 'sign-in') return signIn(req, res);
      const got = await receive(req, 'sigil', { maxFileBytes: SIGIL_MAX_BYTES });
      if (!got.ok) return show(req, res, { ok: false, text: got.text }, { caption: field(req, 'caption') });
      const caption = got.fields.caption ?? '';
      if (got.file === undefined) return show(req, res, { ok: false, text: 'Choose a sigil to upload.' }, { caption });
      const text = got.file.bytes.toString('utf8');
      const lab = labFor(req); // OUTSIDE tryDb: building the lab (the platform's 429) is not a storage error
      const level = impl.for(req.level);
      const stored = tryDb(req, () => {
        const a = level.accept(text); // the level's filter
        if (a.ok) lab.fs.write(SIGIL, a.svg, { contentType: 'image/svg+xml' });
        return a;
      }, 'Storage error');
      if (!stored.ok) return show(req, res, { ok: false, text: stored.message }, { caption });
      if (!stored.value.ok) return show(req, res, { ok: false, text: stored.value.text }, { caption });
      const kept = stored.value.svg;
      const size = Buffer.byteLength(kept, 'utf8');
      const changed = kept === text ? '' : `; the filter changed it (${text.length} characters before, ${kept.length} after)`;
      return show(req, res, { ok: true, text: `Sigil stored (${size} bytes)${changed}.` }, { caption });
    }, (req, res) => show(req, res, {
      ok: false,
      // A body over the engine's 2 MiB cap never reaches the parser; the cap that matters to the player is the sigil's.
      text: req.lang === 'id' ? 'Unggahan terlalu besar (sebuah sigil paling banyak 12 KiB).' : 'The upload is too large (a sigil is at most 12 KiB).',
    }));

    // The stored sigil in the player's real browser: always an inert download, at every level (plan amendment after
    // the E2 review). The payload fires only inside the sandboxed preview on the lab page. The CSP goes through the
    // route-scoped lab-header helper; the download's own framing (type, nosniff, disposition) is outside its
    // allow-list, so plain res.set writes it.
    router.get('/sigil', (req, res) => {
      const file = labFor(req).fs.read(SIGIL);
      if (file === undefined) return res.status(404).set({ 'X-Content-Type-Options': 'nosniff' }).type('text/plain').send('No sigil.');
      res.set({ ...DOWNLOAD_HEADERS });
      setLabHeaders(res, DOWNLOAD_LAB_HEADERS);
      return res.send(file.bytes);
    });
  },
}));
