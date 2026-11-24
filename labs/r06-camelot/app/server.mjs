// labs/r06-camelot/app/server.mjs — Camelot Court. Start hook: read the one-shot flag file (HVWA_FLAG_FILE) once and
// unlink it, then mint the court's keys and words (court.mjs). The flag is held in memory and rendered only on the stone
// page (HTML or JSON) after a proof was accepted: the true words of the King's dream, or a seal whose rank is `knight`.
// Which surface is weak is chosen by HVWA_LEVEL (court.mjs). No sessions, no cookies: every request stands alone.
// Listens on 0.0.0.0:$HVWA_PORT. Standard library only.
import { createServer } from 'node:http';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createCourt } from './court.mjs';
import {
  hallPage, dreamPage, petitionPage, oraclePage, stonePage, notFoundPage,
} from './render.mjs';

const LEVELS = ['acolyte', 'templar', 'inquisitor', 'divine'];
const level = LEVELS.includes(process.env.HVWA_LEVEL ?? '') ? process.env.HVWA_LEVEL : 'acolyte';
const port = Number(process.env.HVWA_PORT || 8080);
const flagSource = process.env.HVWA_FLAG_FILE || '/tmp/.hvwa-flag';
// The image copies app/ and seed/ side by side under /app; in the repo, seed/ sits next to app/.
const seed = JSON.parse(readFileSync(
  existsSync(new URL('./seed/court.json', import.meta.url)) ? new URL('./seed/court.json', import.meta.url) : new URL('../seed/court.json', import.meta.url),
  'utf8'));

/** Poll for the one-shot flag file, read it once and unlink it. Below Divine only; otherwise exit non-zero. */
async function readFlag() {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const value = readFileSync(flagSource, 'utf8').trim();
      if (value) { unlinkSync(flagSource); return value; }
    } catch { /* the warden has not written it yet */ }
    if (Date.now() >= deadline) {
      console.error('camelot: the flag file never appeared'); // never the flag itself
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const flag = level === 'divine' ? undefined : await readFlag();
const court = createCourt(level, seed);

const MAX_BODY = 64 * 1024;
const MAX_SCROLLS = 256;
const SECURITY = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};
const html = (res, status, body) => { res.writeHead(status, { ...SECURITY, 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
// A honeypot header for Network-tab diggers: a decoy (decoys.ts), never the flag.
const json = (res, status, obj) => { res.writeHead(status, { ...SECURITY, 'content-type': 'application/json', 'x-merlin-trace': 'HVWA{h34d3r_hunt3r_lol}' }); res.end(JSON.stringify(obj)); };
const text = (res, status, body) => { res.writeHead(status, { ...SECURITY, 'content-type': 'text/plain; charset=utf-8' }); res.end(body); };

class TooLarge extends Error {}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.off('data', onData); req.resume(); reject(new TooLarge()); return; }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const parseForm = (s) => Object.fromEntries(new URLSearchParams(s));
function parseJson(s) {
  try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
const str = (v) => (typeof v === 'string' ? v : '');
const cleanHex = (s) => str(s).replace(/\s+/g, '').toLowerCase();

/** Try the stone: true words first, then a seal. Returns { knighted, petitioner? }. */
function tryStone({ words, seal }) {
  if (str(words).trim() && court.wordsMatch(str(words))) return { knighted: true };
  const hex = cleanHex(seal);
  if (hex) {
    const read = court.readSeal(hex);
    if (read && read.rank === 'knight') return { knighted: true, petitioner: read.petitioner };
  }
  return { knighted: false };
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://camelot');
  // `/dream/` and `/dream` are the same room; a stray trailing slash never leads to the lost corridor.
  const p = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') || '/' : url.pathname;

  if (p === '/healthz') return json(res, 200, { status: 'ok' });

  // HEAD is answered like GET (Node drops the body), so link checkers and prefetchers see the real status.
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (p === '/') return html(res, 200, hallPage(level));
    if (p === '/dream') return html(res, 200, dreamPage(level, court.dreamScroll()));
    if (p === '/petition') return html(res, 200, petitionPage(level));
    if (p === '/oracle') return html(res, 200, oraclePage(level));
    if (p === '/stone') return html(res, 200, stonePage(level));
    // Rooms from the first edition of the court: old bookmarks land in the Great Hall.
    if (p === '/table' || p === '/clerks') { res.writeHead(303, { ...SECURITY, location: '/' }); return res.end(); }
    if (p === '/robots.txt') return text(res, 200, 'User-agent: *\nDisallow: /royal-treasury\n# treasurer\'s note: HVWA{r0b0ts_txt_tr4p}\n');
    if (p === '/api/dream') return json(res, 200, { scroll: court.dreamScroll() });
  }

  if (req.method === 'POST') {
    let raw;
    try { raw = await readBody(req); } catch (e) {
      if (e instanceof TooLarge) { res.setHeader('connection', 'close'); return json(res, 413, { error: 'the satchel is too heavy' }); }
      throw e;
    }

    if (p === '/petition') {
      const name = str(parseForm(raw).name);
      const seal = court.petition(name);
      return seal
        ? html(res, 200, petitionPage(level, { name, seal }))
        : html(res, 400, petitionPage(level, { name, error: 'The scribe cannot write that name: 1 to 64 characters, no ; or =.' }));
    }
    if (p === '/oracle') {
      const scroll = cleanHex(parseForm(raw).scroll);
      return html(res, 200, oraclePage(level, { scroll, verdict: court.consult(scroll) }));
    }
    if (p === '/stone') {
      const form = parseForm(raw);
      const r = tryStone({ words: form.words, seal: form.seal });
      return html(res, r.knighted ? 200 : 403, stonePage(level, { outcome: r.knighted ? 'knighted' : 'refused', flag: r.knighted ? flag : undefined, petitioner: r.petitioner }));
    }

    const body = parseJson(raw);
    if (p === '/api/petition') {
      const seal = court.petition(str(body.name));
      return seal ? json(res, 200, { seal }) : json(res, 400, { error: 'name: 1 to 64 characters from 0x01 to 0x7e, no ; or =' });
    }
    if (p === '/api/oracle') {
      const scrolls = body.scrolls;
      if (!Array.isArray(scrolls) || scrolls.length < 1 || scrolls.length > MAX_SCROLLS) {
        return json(res, 400, { error: `scrolls: an array of 1 to ${MAX_SCROLLS} hex strings` });
      }
      return json(res, 200, { visions: scrolls.map((s) => court.consult(cleanHex(s))) });
    }
    if (p === '/api/stone') {
      const r = tryStone({ words: body.words, seal: body.seal });
      if (!r.knighted) return json(res, 403, { knighted: false, message: 'The sword does not move.' });
      return json(res, 200, flag
        ? { knighted: true, petitioner: r.petitioner ?? null, writ: flag }
        : { knighted: true, petitioner: r.petitioner ?? null, note: 'secure reference court: no writ' });
    }
  }

  if (p.startsWith('/api/')) return json(res, 404, { error: 'no such clerk' });
  return html(res, 404, notFoundPage());
}

createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) json(res, 500, { error: 'the court is in disarray' });
    else res.end();
  });
}).listen(port, '0.0.0.0', () => console.log(`camelot (${level}) listening on ${port}`));
