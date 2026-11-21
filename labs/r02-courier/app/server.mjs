// labs/r02-courier/app/server.mjs — Courier. Start hook: build the in-memory store, planting HVWA_FLAG as parcel 1001's
// private note, then DELETE HVWA_FLAG from the environment (spec §6). The HTML dashboard uses a demo-session cookie so a
// plain browse works and shows only the demo customer's parcels; the JSON API uses a bearer token. Authorization (which
// parcels a session may read) is the flaw and is chosen by HVWA_LEVEL (store.canRead). Listens on 0.0.0.0:$HVWA_PORT.
import { createServer } from 'node:http';
import { createStore } from './store.mjs';
import { page, esc } from './render.mjs';

const LEVELS = ['acolyte', 'templar', 'divine'];
const level = LEVELS.includes(process.env.HVWA_LEVEL ?? '') ? process.env.HVWA_LEVEL : 'acolyte';
const port = Number(process.env.HVWA_PORT || 8080);

const flag = process.env.HVWA_FLAG;
delete process.env.HVWA_FLAG;
const store = createStore(level, flag);

const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const html = (res, status, body) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
const bearer = (req) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || undefined;
const cookieToken = (req) => Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')))['cs'];

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://courier');
  const p = url.pathname;

  if (p === '/healthz') return json(res, 200, { status: 'ok' });

  // --- HTML: landing and the demo dashboard (browser side; cookie session so a plain GET works) ---
  if (p === '/' && req.method === 'GET') {
    return html(res, 200, page('Home',
      `<h2>Track your parcels</h2><p>Courier customers can follow every parcel from depot to door.</p>`
      + `<p><a class="btn" href="/dashboard">View demo dashboard</a></p>`));
  }
  if (p === '/dashboard' && req.method === 'GET') {
    let token = cookieToken(req);
    if (!store.customerFor(token)) { token = store.openDemoSession(); res.setHeader('set-cookie', `cs=${token}; Path=/; HttpOnly; SameSite=Lax`); }
    const mine = store.parcelsOf('demo').map((p) =>
      `<div class="parcel"><h3>Parcel #${p.id}</h3><div class="status">${esc(p.status)}</div>`
      + `<p>${esc(p.to)}</p><p><a href="/api/parcels/${p.id}/label">Print label</a></p></div>`).join('');
    return html(res, 200, page('Dashboard', `<h2>Your parcels</h2>${mine}`));
  }

  // --- JSON API ---
  if (p === '/api/session' && req.method === 'POST') {
    const token = store.openDemoSession();
    return json(res, 200, { token, customer: 'demo' });
  }
  const customer = store.customerFor(bearer(req));
  if (p.startsWith('/api/') && p !== '/api/session') {
    if (!customer) return json(res, 401, { error: 'sign in: POST /api/session' });

    if (p === '/api/parcels' && req.method === 'GET') {
      return json(res, 200, { parcels: store.parcelsOf(customer).map(({ id, to, status }) => ({ id, to, status })) });
    }
    const mDetail = p.match(/^\/api\/parcels\/(\d+)$/);
    const mLabel = p.match(/^\/api\/parcels\/(\d+)\/label$/);
    const mEvents = p.match(/^\/api\/parcels\/(\d+)\/events$/);
    const route = mDetail ? 'detail' : mLabel ? 'label' : mEvents ? 'events' : null;
    const id = route ? Number((mDetail ?? mLabel ?? mEvents)[1]) : null;
    if (route) {
      const parcel = store.parcel(id);
      if (!parcel) return json(res, 404, { error: 'no such parcel' });
      if (!store.canRead(customer, parcel, route)) return json(res, 403, { error: 'not your parcel' });
      if (route === 'detail') return json(res, 200, { id: parcel.id, to: parcel.to, status: parcel.status, note: parcel.note });
      if (route === 'label') return json(res, 200, { id: parcel.id, address: parcel.to, note: parcel.note });
      return json(res, 200, { id: parcel.id, events: [{ at: 'depot', status: parcel.status }] });
    }
    return json(res, 404, { error: 'unknown resource' });
  }

  return html(res, 404, page('Not found', `<p class="parcel">Page not found.</p>`));
}).listen(port, '0.0.0.0', () => console.log(`courier on :${port} (${level})`));
