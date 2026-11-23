// labs/r02-courier/app/server.mjs — Courier. Start hook: read the one-shot flag file (HVWA_FLAG_FILE) once and unlink it,
// then build the in-memory store, which plants the flag on the surface that belongs to the level (spec §6): Acolyte
// uses parcel 1001's note, Templar a random vault parcel's label copy, Inquisitor a random vault parcel's manifest.
// The HTML portal uses a demo-session cookie so a plain browse works and shows only the demo customer's parcels; the
// JSON API also accepts a bearer token. Authorization (which parcels a session may read) is the flaw and is chosen by
// HVWA_LEVEL (store.canRead). From Inquisitor up, parcel routes also require the parcel owner's API key in X-Api-Key;
// support may hand out any customer's key to any signed-in session, so a demo bearer plus the vault key reads the
// vault's parcel. The label route content-negotiates: browsers get a printable label page, API clients (Accept: */*)
// get the JSON the reference solves rely on. The authorization decision is made before either representation is chosen.
// Listens on 0.0.0.0:$HVWA_PORT.
import { createServer } from 'node:http';
import { readFileSync, unlinkSync } from 'node:fs';
import { createStore } from './store.mjs';
import { labelDocument } from './render.mjs';
import {
  landingPage, dashboardPage, trackPage, accountPage, supportPage, pricingPage, faqPage,
  signinPage, notFoundPage, serverErrorPage,
} from './pages.mjs';

const LEVELS = ['acolyte', 'templar', 'inquisitor', 'divine'];
const level = LEVELS.includes(process.env.HVWA_LEVEL ?? '') ? process.env.HVWA_LEVEL : 'acolyte';
const port = Number(process.env.HVWA_PORT || 8080);
const flagSource = process.env.HVWA_FLAG_FILE || '/tmp/.hvwa-flag';

/** Poll for the one-shot flag file, read it once and unlink it. Below Divine only; otherwise exit non-zero. */
async function readFlag() {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const value = readFileSync(flagSource, 'utf8').trim();
      if (value) { unlinkSync(flagSource); return value; }
    } catch { /* the warden has not written it yet */ }
    if (Date.now() >= deadline) {
      console.error('courier: the flag file never appeared'); // never the flag itself
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const flag = level === 'divine' ? undefined : await readFlag();
const store = createStore(level, flag);

// A honeypot the API echoes in a header for Network-tab diggers — a decoy, never the flag (decoys.ts: n1c3_try_sm4rt_guy).
const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-courier-trace': 'HVWA{n1c3_try_sm4rt_guy}' }); res.end(JSON.stringify(obj)); };
const html = (res, status, body) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
const redirect = (res, location) => { res.writeHead(303, { location, 'cache-control': 'no-store' }); res.end(); };
const bearer = (req) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || undefined;
const apiKeyOf = (req) => (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined);
const cookieToken = (req) => Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')))['cs'];
const wantsHtml = (req) => /text\/html/i.test(req.headers.accept ?? '');

/** Resolve the portal's cookie session, opening a demo session (and setting the cookie) on first visit. */
function portalSession(req, res) {
  let token = cookieToken(req);
  let customer = store.customerFor(token);
  if (!customer) {
    token = store.openDemoSession();
    customer = store.customerFor(token);
    res.setHeader('set-cookie', `cs=${token}; Path=/; HttpOnly; SameSite=Lax`);
  }
  return customer;
}

const summary = ({ id, to, status, service, weight, eta }) => ({ id, to, status, service, weight, eta });

function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://courier');
  const p = url.pathname;

  if (p === '/healthz') return json(res, 200, { status: 'ok' });

  // --- HTML portal (browser side; cookie session so a plain GET works) ---
  if (req.method === 'GET') {
    if (p === '/') return html(res, 200, landingPage());
    if (p === '/signin') return html(res, 200, signinPage());
    if (p === '/dashboard') {
      const customer = portalSession(req, res);
      return html(res, 200, dashboardPage(store.parcelsOf(customer)));
    }
    if (p === '/track') {
      const customer = portalSession(req, res);
      const mine = store.parcelsOf(customer);
      const raw = url.searchParams.get('id') ?? '';
      if (!raw) return html(res, 200, trackPage({ mine, query: '' }));
      const parcel = /^\d+$/.test(raw) ? store.parcel(Number(raw)) : undefined;
      const own = parcel && parcel.owner === customer ? parcel : undefined; // browsing pages only ever show your own
      return html(res, own ? 200 : 404, trackPage({ parcel: own, mine, query: raw }));
    }
    if (p === '/account') return html(res, 200, accountPage());
    if (p === '/support') return html(res, 200, supportPage());
    if (p === '/pricing') return html(res, 200, pricingPage());
    if (p === '/faq') return html(res, 200, faqPage());
  }

  // --- JSON API ---
  if (p === '/api/session' && req.method === 'POST') {
    const token = store.openDemoSession();
    return json(res, 200, { token, customer: 'demo' });
  }
  const customer = store.customerFor(bearer(req) ?? cookieToken(req));
  if (p.startsWith('/api/') && p !== '/api/session') {
    if (!customer) return wantsHtml(req) ? redirect(res, '/dashboard') : json(res, 401, { error: 'sign in: POST /api/session' });

    // Support customer lookup. A bearer session is required; there is no ownership check at Inquisitor, so any
    // customer's key can be fetched by id. Divine lets a session fetch only its own key. Earlier levels have no route.
    const mSupport = p.match(/^\/api\/support\/customers\/([a-z0-9_-]+)$/);
    if (mSupport && req.method === 'GET') {
      const sessionCustomer = store.customerFor(bearer(req));
      if (!sessionCustomer) return json(res, 401, { error: 'a bearer session is required' });
      if (level !== 'inquisitor' && level !== 'divine') return json(res, 404, { error: 'unknown resource' });
      const target = mSupport[1];
      if (level === 'divine' && target !== sessionCustomer) return json(res, 403, { error: 'not your account' });
      if (!store.customerExists(target)) return json(res, 404, { error: 'no such customer' });
      // Support also lists the customer's parcel ids, so the vault key can be used without guessing the id block.
      return json(res, 200, { customer: target, apiKey: store.apiKeyFor(target), parcels: store.parcelIdsOf(target) });
    }

    if (p === '/api/parcels' && req.method === 'GET') {
      return json(res, 200, { parcels: store.parcelsOf(customer).map(summary) });
    }
    const mDetail = p.match(/^\/api\/parcels\/(\d+)$/);
    const mLabel = p.match(/^\/api\/parcels\/(\d+)\/label$/);
    const mEvents = p.match(/^\/api\/parcels\/(\d+)\/events$/);
    const route = mDetail ? 'detail' : mLabel ? 'label' : mEvents ? 'events' : null;
    const id = route ? Number((mDetail ?? mLabel ?? mEvents)[1]) : null;
    if (route) {
      const parcel = store.parcel(id);
      if (!parcel) return json(res, 404, { error: 'no such parcel' });
      if (!store.canRead(customer, parcel, route, apiKeyOf(req))) return json(res, 403, { error: 'not your parcel' });
      if (route === 'detail') {
        return json(res, 200, {
          id: parcel.id, to: parcel.to, status: parcel.status, note: parcel.note,
          manifest: parcel.manifest, service: parcel.service, weight: parcel.weight, eta: parcel.eta,
        });
      }
      if (route === 'label') {
        // Same authorization decision above; only the representation changes. The label copy is its own
        // surface: Templar's flag lives here while the detail note is a decoy.
        if (wantsHtml(req)) return html(res, 200, labelDocument(parcel));
        return json(res, 200, {
          id: parcel.id, address: parcel.to, note: parcel.note, labelNote: parcel.labelNote,
          service: parcel.service, weight: parcel.weight, eta: parcel.eta,
        });
      }
      const events = Array.isArray(parcel.events) && parcel.events.length
        ? parcel.events
        : [{ at: 'depot', status: parcel.status }];
      return json(res, 200, { id: parcel.id, events });
    }
    return json(res, 404, { error: 'unknown resource' });
  }

  return html(res, 404, notFoundPage());
}

createServer((req, res) => {
  try {
    handle(req, res);
  } catch {
    // Never echo exception details (they can include request data). The flag is never in a message anyway.
    console.error('courier: request failed');
    try {
      if (!res.headersSent) html(res, 500, serverErrorPage());
      else res.destroy();
    } catch { /* the socket is already gone */ }
  }
}).listen(port, '0.0.0.0', () => console.log(`courier on :${port} (${level})`));
