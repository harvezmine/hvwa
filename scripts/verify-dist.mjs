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

// A tiny cookie jar, so this script behaves like a browser: the first response's hvwa_sid (and any
// other Set-Cookie) is sent on every later request. Without it every request mints a NEW session and
// trips the server's new-session issuance limit (60/min) once enough challenges are registered.
// Platform cookies are Path=/; sending every cookie everywhere is enough for these probes.
const jar = new Map();
const sidsSeen = new Set();
const MAX_SIDS = 2; // one for the whole run; one spare
async function jfetch(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...init.headers, ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) } });
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    jar.set(name, value);
    if (name === 'hvwa_sid') sidsSeen.add(value);
  }
  return res;
}

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
      const res = await jfetch(url);
      if (res.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not answer ${url} within ${timeoutMs} ms`);
}

async function expectOk(base, path, check) {
  const res = await jfetch(base + path);
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

/** The challenge page's level tabs, found by data-testid="level-tab-<level>" in any attribute order. */
function levelTabs(page) {
  const tabs = [];
  for (const [tag] of page.matchAll(/<a\b[^>]*>/g)) {
    const level = /\bdata-testid="level-tab-([a-z]+)"/.exec(tag)?.[1];
    if (!level) continue;
    const href = /\bhref="([^"]*)"/.exec(tag)?.[1];
    if (!href) throw new Error(`level tab ${level} has no href`);
    tabs.push({ level, href: unescapeHtml(href) });
  }
  return tabs;
}

/** Wait for a line of the server's output matching `re`; returns the match. */
async function waitForOutput(read, re, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const m = re.exec(read());
    if (m) return m;
    if (Date.now() > deadline) throw new Error(`server never printed a line matching ${re}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

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
    const tabs = levelTabs(page);
    if (tabs.length === 0) throw new Error(`/c/${id} links no lab level`);
    const levels = [];
    for (const { level, href: lab } of tabs) {
      if (!lab.startsWith('/d/') || new URL(lab, base).searchParams.get('level') !== level) {
        throw new Error(`/c/${id}: level tab ${level} links ${lab}`);
      }
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

    // Every registered challenge must be reachable from the portal.
    const [, count] = await waitForOutput(() => output, /^HVWA: (\d+) challenge\(s\) registered\r?$/m, 5000);
    if (Number(count) !== ids.length) {
      throw new Error(`the server registered ${count} challenge(s) but ${ids.length} were discovered over HTTP`);
    }
    say(`server registered ${count} challenge(s): all discovered`);

    // Guard: a client that keeps its cookie jar is handed ONE session. More means the jar broke and
    // the run is leaning on (and soon tripping) the session issuance limit.
    if (sidsSeen.size > MAX_SIDS) {
      throw new Error(`the server handed out ${sidsSeen.size} distinct hvwa_sid values (max ${MAX_SIDS}): the cookie jar is not being sent`);
    }
    say(`session kept: ${sidsSeen.size} distinct hvwa_sid issued over the whole run`);
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
