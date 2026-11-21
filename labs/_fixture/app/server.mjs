// labs/_fixture/app/server.mjs — the range fixture (NOT a lab). Its start hook reads the one-shot flag file the warden
// wrote after start (HVWA_FLAG_FILE, default /tmp/.hvwa-flag), unlinks it, then plants it where lab.json says (a file)
// and serves it as a page (spec range §6). Divine gets no flag and plants a decoy. /env and /headers are diagnostics for
// scripts/range-verify.mjs.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const LEVELS = ['acolyte', 'templar', 'inquisitor', 'divine'];
const level = LEVELS.includes(process.env.HVWA_LEVEL ?? '') ? process.env.HVWA_LEVEL : 'acolyte';
const port = Number(process.env.HVWA_PORT || 8080);
const host = process.env.HVWA_INSTANCE_HOST || 'localhost';
// Only the fixture's own spec moves the file (it runs outside a container); in the image it is lab.json's path.
const flagFile = process.env.HVWA_FIXTURE_FLAG_FILE || '/tmp/hvwa/flag.txt';
const flagSource = process.env.HVWA_FLAG_FILE || '/tmp/.hvwa-flag';
const DECOY = 'Divine is the secure reference: there is no flag here.';

/** Poll for the one-shot flag file, read it once and unlink it. Below Divine only; otherwise exit non-zero. */
async function readFlag() {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const value = readFileSync(flagSource, 'utf8').trim();
      if (value) { unlinkSync(flagSource); return value; }
    } catch { /* the warden has not written it yet */ }
    if (Date.now() >= deadline) {
      console.error('fixture: the flag file never appeared'); // never the flag itself
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const flag = level === 'divine' ? undefined : await readFlag();
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
