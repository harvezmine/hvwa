// labs/r01-mercy-clinic/app/server.mjs — Mercy Clinic. Start hook: open the SQLite DB in /tmp, seed it, plant the flag
// as a staff-only notice, then DELETE HVWA_FLAG from the environment before serving (spec §6). The notice search at
// /search is the vulnerable feature; its behaviour is chosen by HVWA_LEVEL (db.mjs). Listens on 0.0.0.0:$HVWA_PORT.
import { createServer } from 'node:http';
import { openDb, plantFlag, listPublic, getPublic, listPatients, searchNotices } from './db.mjs';
import { page, noticeCard, esc } from './render.mjs';

const LEVELS = ['acolyte', 'templar', 'divine'];
const level = LEVELS.includes(process.env.HVWA_LEVEL ?? '') ? process.env.HVWA_LEVEL : 'acolyte';
const port = Number(process.env.HVWA_PORT || 8080);

const flag = process.env.HVWA_FLAG;
delete process.env.HVWA_FLAG;                 // the process must not keep the flag in its environment
const db = openDb('/tmp/clinic.db');
plantFlag(db, level, flag);

const send = (res, status, type, body) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
const html = (res, status, body) => send(res, status, 'text/html; charset=utf-8', body);

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://clinic');
  const p = url.pathname;

  if (p === '/healthz') return send(res, 200, 'application/json', '{"status":"ok"}');

  if (p === '/') {
    const notices = listPublic(db).map(noticeCard).join('');
    return html(res, 200, page('Home',
      `<h2>Patient notices</h2>`
      + `<form class="search" action="/search" method="get"><input name="q" placeholder="Search notices"><button>Search</button></form>`
      + notices));
  }

  if (p === '/search') {
    const q = url.searchParams.get('q') ?? '';
    const rows = q.trim() === '' ? [] : searchNotices(db, level, q);
    const results = rows.length ? rows.map(noticeCard).join('') : `<p class="card">No notices matched “${esc(q)}”.</p>`;
    return html(res, 200, page('Search',
      `<form class="search" action="/search" method="get"><input name="q" value="${esc(q)}"><button>Search</button></form>`
      + `<h2>Results</h2>${results}`));
  }

  if (p === '/patients') {
    const rows = listPatients(db).map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.role)}</td><td>${esc(r.room)}</td></tr>`).join('');
    return html(res, 200, page('Our team', `<h2>Our team</h2><table><tr><th>Name</th><th>Role</th><th>Room</th></tr>${rows}</table>`));
  }

  const mNotice = p.match(/^\/notices\/(\d+)$/);
  if (mNotice) {
    const n = getPublic(db, Number(mNotice[1]));
    if (!n) return html(res, 404, page('Not found', `<p class="card">That notice is not available.</p>`));
    return html(res, 200, page(n.title, noticeCard(n)));
  }

  return html(res, 404, page('Not found', `<p class="card">Page not found.</p>`));
}).listen(port, '0.0.0.0', () => console.log(`mercy-clinic on :${port} (${level})`));
