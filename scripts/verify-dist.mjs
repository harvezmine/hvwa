// scripts/verify-dist.mjs — `npm run verify:dist` (NOT part of `npm test`).
// Builds, boots dist/server.js on a free loopback port with a throwaway data
// dir, probes it, then shuts it down. Exit code 0 = the production build runs.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
    await expectOk(base, '/', (b) => {
      if (!/^<!doctype html>/i.test(b) || !b.includes('/static/app.css')) throw new Error('/ is not the portal page');
    });
    await expectOk(base, '/static/app.css', () => {});
    await expectOk(base, '/static/vendor/htmx.min.js', () => {});

    // Every registered challenge: its player page and its first level's View Source
    // (proves levels/*.ts were copied into dist/). The registry is read from the
    // built app itself, so each new challenge is covered automatically.
    await import(pathToFileURL(join(root, 'dist', 'districts', 'index.js')).href);
    const { allChallenges } = await import(pathToFileURL(join(root, 'dist', 'core', 'registry.js')).href);
    const challenges = allChallenges();
    if (challenges.length === 0) throw new Error('no challenges registered in the built app');
    for (const c of challenges) {
      await expectOk(base, `/c/${c.id}`, (b) => {
        if (!b.includes(c.id)) throw new Error(`/c/${c.id} does not mention the challenge`);
      });
      await expectOk(base, `/c/${c.id}/source/${c.levels[0]}`, (b) => {
        if (b.length < 200) throw new Error(`/c/${c.id}/source/${c.levels[0]} looks empty`);
      });
    }
    say(`checked ${challenges.length} registered challenge(s): ${challenges.map((c) => c.id).join(', ')}`);
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
