// labs/r03-beacon/app/server.mjs — Beacon. Start hook: write HVWA_FLAG (or a Divine decoy) to /tmp/beacon/flag.txt, then
// DELETE HVWA_FLAG from the environment (spec §6). /diagnostics runs the per-level probe (diag.mjs). No page renders the
// flag file; only a shell that reads it does. Listens on 0.0.0.0:$HVWA_PORT.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { probe } from './diag.mjs';
import { page, esc } from './render.mjs';

const LEVELS = ['acolyte', 'templar', 'divine'];
const level = LEVELS.includes(process.env.HVWA_LEVEL ?? '') ? process.env.HVWA_LEVEL : 'acolyte';
const port = Number(process.env.HVWA_PORT || 8080);
const device = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'seed', 'device.json'), 'utf8'));

const flag = process.env.HVWA_FLAG;
delete process.env.HVWA_FLAG;
mkdirSync('/tmp/beacon', { recursive: true });
writeFileSync('/tmp/beacon/flag.txt',
  `${level === 'divine' || !flag ? 'Divine is the secure reference: the probe runs no shell, so there is nothing to inject.' : flag}\n`,
  { mode: 0o400 });

const html = (res, status, body) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 4096) req.destroy(); }); req.on('end', () => resolve(b)); });

const diagForm = (host = '', output = '') =>
  `<div class="panel"><h2>Connectivity diagnostics</h2>`
  + `<form method="post" action="/diagnostics"><input name="host" value="${esc(host)}" placeholder="host to probe"><button>Run probe</button></form>`
  + (output ? `<pre>${esc(output)}</pre>` : '') + `</div>`;

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://beacon');
  const p = url.pathname;

  if (p === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"status":"ok"}'); }

  if (p === '/' && req.method === 'GET') {
    return html(res, 200, page('Dashboard', `<div class="panel"><h2>${esc(device.model)}</h2><p>Firmware ${esc(device.firmware)} • WAN ${esc(device.wan)} • LAN ${esc(device.lan)}</p></div>`));
  }
  if (p === '/status' && req.method === 'GET') {
    const rows = Object.entries(device).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`).join('');
    return html(res, 200, page('Status', `<div class="panel"><h2>Device status</h2><table>${rows}</table></div>`));
  }
  if (p === '/diagnostics' && req.method === 'GET') return html(res, 200, page('Diagnostics', diagForm()));
  if (p === '/diagnostics' && req.method === 'POST') {
    const body = new URLSearchParams(await readBody(req));
    const host = body.get('host') ?? '';
    const r = await probe(level, host);
    return html(res, 200, page('Diagnostics', diagForm(host, r.error ?? r.output)));
  }

  return html(res, 404, page('Not found', `<div class="panel">Page not found.</div>`));
}).listen(port, '0.0.0.0', () => console.log(`beacon on :${port} (${level})`));
