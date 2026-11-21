// labs/_fixture/app/server.mjs — the range fixture (NOT a lab). Its start hook plants HVWA_FLAG where lab.json says (a
// file) and serves it as a page, then removes it from process.env, as every range lab must (spec range §6). Divine gets
// no flag and plants a decoy. /env and /headers are diagnostics for scripts/range-verify.mjs.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const LEVELS = ['acolyte', 'templar', 'inquisitor', 'divine'];
const level = LEVELS.includes(process.env.HVWA_LEVEL ?? '') ? process.env.HVWA_LEVEL : 'acolyte';
const port = Number(process.env.HVWA_PORT || 8080);
const host = process.env.HVWA_INSTANCE_HOST || 'localhost';
// Only the fixture's own spec moves the file (it runs outside a container); in the image it is lab.json's path.
const flagFile = process.env.HVWA_FIXTURE_FLAG_FILE || '/tmp/hvwa/flag.txt';
const DECOY = 'Divine is the secure reference: there is no flag here.';

const flag = process.env.HVWA_FLAG;
delete process.env.HVWA_FLAG;
mkdirSync(dirname(flagFile), { recursive: true });
writeFileSync(flagFile, `${level === 'divine' || !flag ? DECOY : flag}\n`, { mode: 0o400 });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1>${body}</body></html>`;

createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://fixture').pathname;
  const send = (status, type, body) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  if (path === '/healthz') return send(200, 'application/json', '{"status":"ok"}');
  if (path === '/') return send(200, 'text/html; charset=utf-8', page('Range fixture',
    `<p>Level: <span data-testid="level">${esc(level)}</span></p><p>Host: ${esc(host)}</p><p><a href="/flag">Flag</a></p>`));
  if (path === '/flag') return send(200, 'text/html; charset=utf-8', page('Flag', `<pre data-testid="flag">${esc(readFileSync(flagFile, 'utf8').trim())}</pre>`));
  if (path === '/env') return send(200, 'application/json', JSON.stringify({ flagInEnv: 'HVWA_FLAG' in process.env, uid: process.getuid?.() ?? null }));
  if (path === '/headers') return send(200, 'application/json', JSON.stringify(req.headers));
  return send(404, 'text/plain', 'not found\n');
}).listen(port, '0.0.0.0', () => { console.log(`fixture on :${port} (${level})`); });
