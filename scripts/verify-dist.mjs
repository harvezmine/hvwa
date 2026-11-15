// scripts/verify-dist.mjs — `npm run verify:dist` (NOT part of `npm test`).
// Builds, boots dist/server.js on a free loopback port with a throwaway data
// dir, probes it, then shuts it down. Exit code 0 = the production build runs.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const say = (msg) => console.log(`verify:dist ${msg}`);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitUntilUp(url, exited, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let earlyExit;
  exited.then((e) => { earlyExit = e; });
  while (Date.now() < deadline) {
    if (earlyExit) throw new Error(`server exited early (code ${earlyExit.code}, signal ${earlyExit.signal})`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not answer ${url} within ${timeoutMs} ms`);
}

async function expectOk(base, path, check) {
  const res = await fetch(base + path);
  const body = await res.text();
  if (res.status !== 200) throw new Error(`GET ${path} → ${res.status}`);
  check(body);
  say(`GET ${path} → 200 (${body.length} bytes)`);
  return body;
}

/** Undo EJS's HTML escaping (attribute values and <pre> text). */
const unescapeHtml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#34;|&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** Unique first capture groups of a global regex over html, unescaped. */
const captures = (html, re) => [...new Set([...html.matchAll(re)].map((m) => unescapeHtml(m[1])))];

// A level file is a TypeScript module: View Source must show at least one export.
const EXPORT_RE = /\bexport\s+(async\s+)?(function|const|let|class|interface|type|default)\b/;

/**
 * Discover every challenge from the running server — the portal index links
 * /c/<id>; each challenge page links its lab at every implemented level — and
 * probe the challenge page, every lab level (lab bar present, level served),
 * every level's View Source (real source, which proves levels/*.ts reached
 * dist/) and the diff. Nothing from dist/ is imported into this process.
 */
async function verifyChallenges(base, indexHtml) {
  const ids = captures(indexHtml, /href="\/c\/([A-Z]{2}-\d{2})"/g);
  if (ids.length === 0) throw new Error('no challenges discovered: the portal index links no /c/<id> page');
  for (const id of ids) {
    const page = await expectOk(base, `/c/${id}`, (b) => {
      if (!b.includes(id)) throw new Error(`/c/${id} does not mention the challenge`);
    });
    const labs = captures(page, /<a class="level-tab"[^>]*href="([^"]+)"/g);
    if (labs.length === 0) throw new Error(`/c/${id} links no lab level`);
    const levels = [];
    for (const lab of labs) {
      const level = new URL(lab, base).searchParams.get('level');
      if (!level || !lab.startsWith('/d/')) throw new Error(`/c/${id}: unexpected lab link ${lab}`);
      levels.push(level);
      await expectOk(base, lab, (b) => {
        if (!b.includes('data-testid="lab-bar"')) throw new Error(`${lab} has no lab bar`);
        if (!new RegExp(`data-testid="lab-level"[^>]*data-level="${level}"`).test(b)) {
          throw new Error(`${lab} does not serve level ${level}`);
        }
        if (!b.includes(`href="/c/${id}"`)) throw new Error(`${lab} has no link back to /c/${id}`);
      });
    }
    for (const level of levels) {
      const path = `/c/${id}/source/${level}`;
      await expectOk(base, path, (b) => {
        const code = /<pre class="source-view"><code>([\s\S]*?)<\/code><\/pre>/.exec(b)?.[1];
        if (code === undefined) throw new Error(`${path} has no source block`);
        if (!EXPORT_RE.test(unescapeHtml(code))) throw new Error(`${path} does not show the level's source (no export)`);
      });
    }
    if (levels.includes('divine') && levels.some((l) => l !== 'divine')) {
      await expectOk(base, `/c/${id}/diff`, (b) => {
        if (!b.includes('class="diff-view"')) throw new Error(`/c/${id}/diff has no diff table`);
      });
    }
    say(`${id}: page, ${levels.length} lab level(s) [${levels.join(', ')}], their sources and the diff`);
  }
  return ids;
}

async function main() {
  say('building: npm run build');
  const build = spawnSync('npm run build', { cwd: root, stdio: 'inherit', shell: true });
  if (build.status !== 0) throw new Error(`build failed (exit ${build.status})`);

  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'hvwa-verify-'));
  const base = `http://127.0.0.1:${port}`;
  say(`booting dist/server.js on ${base} (HVWA_DATA_DIR=${dataDir})`);
  const child = spawn(process.execPath, [join(root, 'dist', 'server.js')], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), HVWA_DATA_DIR: dataDir, HVWA_ALLOW_REMOTE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  try {
    await waitUntilUp(`${base}/healthz`, exited, 15000);
    const banner = output.split(/\r?\n/).find((l) => l.startsWith('HVWA on '));
    say(`server says: ${banner ?? '(no banner)'}`);
    await expectOk(base, '/healthz', (b) => {
      if (JSON.parse(b).status !== 'ok') throw new Error(`/healthz body ${b}`);
    });
    const index = await expectOk(base, '/', (b) => {
      if (!/^<!doctype html>/i.test(b) || !b.includes('/static/app.css')) throw new Error('/ is not the portal page');
    });
    await expectOk(base, '/static/app.css', () => {});
    await expectOk(base, '/static/vendor/htmx.min.js', () => {});

    const ids = await verifyChallenges(base, index);
    say(`checked ${ids.length} challenge(s) discovered over HTTP: ${ids.join(', ')}`);
  } catch (err) {
    console.error(output);
    throw err;
  } finally {
    child.kill();
    await exited;
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    say('server stopped, temp data dir removed');
  }
}

main().then(
  () => { say('OK — the production build boots and serves'); },
  (err) => { console.error(`verify:dist FAILED: ${err.message}`); process.exitCode = 1; },
);
