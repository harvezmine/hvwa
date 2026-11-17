// scripts/verify-dist.mjs — `npm run verify:dist` (NOT part of `npm test`).
// Builds, boots dist/server.js on a free loopback port with a throwaway data
// dir, probes it, then shuts it down. Exit code 0 = the production build runs.
//
// It boots the build the way the Docker image does: NODE_ENV=production, so the platform login is ON
// (unless HVWA_AUTH=off is set for this run), and signs in with the default admin / password before
// probing. HVWA_EDITION is passed through: `HVWA_EDITION=lite npm run verify:dist` expects exactly the
// lite edition's 5 challenges.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const say = (msg) => console.log(`verify:dist ${msg}`);

// What this run expects, from the same variables the server reads (blank = unset, as in config.ts).
const setting = (name) => (process.env[name] ?? '').trim();
const EDITION = setting('HVWA_EDITION') || 'full';
if (!['full', 'lite'].includes(EDITION)) throw new Error(`verify:dist: HVWA_EDITION must be full or lite (got "${EDITION}")`);
const AUTH = setting('HVWA_AUTH') || 'on'; // NODE_ENV=production below: unset means on
if (!['on', 'off'].includes(AUTH)) throw new Error(`verify:dist: HVWA_AUTH must be on or off (got "${AUTH}")`);
/** The lite edition's size (src/editions.ts holds the list; the server's banner line names the edition). */
const LITE_COUNT = 5;
const DEFAULT_LOGIN = { username: 'admin', password: 'password' };

// A tiny cookie jar, so this script behaves like a browser: the first response's hvwa_sid (and any
// other Set-Cookie) is sent on every later request. Without it every request mints a NEW session and
// trips the server's new-session issuance limit (60/min) once enough challenges are registered.
// Platform cookies are Path=/; sending every cookie everywhere is enough for these probes. A cookie
// set to '' (a cleared one: logout) is dropped. Redirects are never followed: a 303 to /login must
// show up as a 303, not as the login page's 200.
const jar = new Map();
const sidsSeen = new Set();
const MAX_SIDS = 2; // one for the whole run; one spare
async function jfetch(url, init = {}) {
  const res = await fetch(url, {
    ...init, redirect: 'manual',
    headers: { ...init.headers, ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) },
  });
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === '') jar.delete(name);
    else jar.set(name, value);
    if (name === 'hvwa_sid') sidsSeen.add(value);
  }
  return res;
}

/** POST an urlencoded form through the jar. */
const postForm = (url, fields) => jfetch(url, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(),
});
const csrfOf = (html) => {
  const v = /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
  if (!v) throw new Error('no _csrf field on the page');
  return v;
};

/**
 * The platform login, end to end: a signed-out browser is sent to /login (303) and the API answers 401;
 * the default admin / password signs in (303, hvwa_auth) and the default-password banner shows.
 */
async function signIn(base) {
  const gated = await jfetch(`${base}/`);
  await gated.arrayBuffer();
  if (gated.status !== 303 || gated.headers.get('location') !== '/login?next=%2F') {
    throw new Error(`signed out, GET / -> ${gated.status} ${gated.headers.get('location') ?? ''} (expected 303 to /login?next=%2F)`);
  }
  const api = await jfetch(`${base}/api/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const apiBody = await api.text();
  if (api.status !== 401 || JSON.parse(apiBody).error !== 'unauthorized') throw new Error(`signed out, POST /api/submit -> ${api.status} ${apiBody}`);
  const page = await jfetch(`${base}/login`);
  const html = await page.text();
  if (page.status !== 200 || !html.includes('action="/login"')) throw new Error(`GET /login -> ${page.status}`);
  const wrong = await postForm(`${base}/login`, { _csrf: csrfOf(html), username: 'admin', password: 'not-the-password' });
  await wrong.arrayBuffer();
  if (wrong.status !== 401) throw new Error(`a wrong password -> ${wrong.status} (expected 401)`);
  const res = await postForm(`${base}/login`, { _csrf: csrfOf(html), ...DEFAULT_LOGIN, next: '/' });
  await res.arrayBuffer();
  if (res.status !== 303 || res.headers.get('location') !== '/') throw new Error(`POST /login as admin -> ${res.status} (expected 303 to /)`);
  if (!jar.get('hvwa_auth')) throw new Error('POST /login set no hvwa_auth cookie');
  say('login: signed out -> 303 /login and /api 401; admin / password (the default) -> 303 + hvwa_auth');
}

/** Sign out at the end: the token is revoked and the portal is gated again. */
async function signOut(base) {
  const page = await jfetch(`${base}/account/password`);
  const html = await page.text();
  if (page.status !== 200) throw new Error(`GET /account/password -> ${page.status}`);
  const res = await postForm(`${base}/logout`, { _csrf: csrfOf(html) });
  await res.arrayBuffer();
  if (res.status !== 303 || res.headers.get('location') !== '/login') throw new Error(`POST /logout -> ${res.status}`);
  const after = await jfetch(`${base}/`);
  await after.arrayBuffer();
  if (after.status !== 303) throw new Error(`after logout, GET / -> ${after.status} (expected 303)`);
  say('logout: 303 /login, the portal is gated again');
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
  say(`booting dist/server.js on ${base} (HVWA_DATA_DIR=${dataDir}, NODE_ENV=production, edition ${EDITION}, login ${AUTH})`);
  const child = spawn(process.execPath, [join(root, 'dist', 'server.js')], {
    cwd: root,
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), HVWA_DATA_DIR: dataDir, HVWA_ALLOW_REMOTE: '0',
      // As in the Docker image. A fresh data dir and no HVWA_ADMIN_PASSWORD: the account starts as admin / password.
      NODE_ENV: 'production', HVWA_EDITION: EDITION, HVWA_AUTH: AUTH, HVWA_ADMIN_PASSWORD: '',
    },
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
    // The static assets are open even before signing in (the login page needs them).
    await expectOk(base, '/static/app.css', () => {});
    await expectOk(base, '/static/vendor/htmx.min.js', () => {});

    await waitForOutput(() => output, new RegExp(`^HVWA: edition ${EDITION}\\r?$`, 'm'), 5000);
    await waitForOutput(() => output, AUTH === 'on' ? /^HVWA: login on \(user admin\)\r?$/m : /^HVWA: login off/m, 5000);
    if (AUTH === 'on') {
      await waitForOutput(() => output, /^HVWA: the admin account still uses the DEFAULT password/m, 5000);
      await signIn(base);
    } else {
      const login = await jfetch(`${base}/login`);
      await login.arrayBuffer();
      if (login.status !== 404) throw new Error(`HVWA_AUTH=off but GET /login -> ${login.status} (expected 404)`);
      say('login: off (HVWA_AUTH=off): no /login, the portal is open');
    }

    const index = await expectOk(base, '/', (b) => {
      if (!/^<!doctype html>/i.test(b) || !b.includes('/static/app.css')) throw new Error('/ is not the portal page');
      const banner = b.includes('data-testid="default-password-banner"');
      if (AUTH === 'on' && !banner) throw new Error('signed in with the default password, but / shows no default-password banner');
      if (AUTH === 'off' && (banner || b.includes('data-testid="account-nav"'))) throw new Error('login off, but / shows login markup');
    });

    const ids = await verifyChallenges(base, index);
    say(`checked ${ids.length} challenge(s) discovered over HTTP: ${ids.join(', ')}`);

    // Every registered challenge must be reachable from the portal.
    const [, count] = await waitForOutput(() => output, /^HVWA: (\d+) challenge\(s\) registered\r?$/m, 5000);
    if (Number(count) !== ids.length) {
      throw new Error(`the server registered ${count} challenge(s) but ${ids.length} were discovered over HTTP`);
    }
    if (EDITION === 'lite' && ids.length !== LITE_COUNT) {
      throw new Error(`the lite edition serves ${ids.length} challenge(s), expected exactly ${LITE_COUNT}`);
    }
    say(`server registered ${count} challenge(s) (edition ${EDITION}): all discovered`);

    if (AUTH === 'on') await signOut(base);

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
