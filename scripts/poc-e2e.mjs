// scripts/poc-e2e.mjs — `npm run poc:e2e` (NOT part of `npm test`; needs Docker Engine 28+, the docker CLI and a free
// loopback port 18081). The end-to-end proof that every REAL lab in labs/registry.json works through the range PORTAL:
// for r01 Mercy Clinic, r02 Courier, r03 Beacon and r04 Postcard at every level (acolyte, templar, inquisitor,
// divine), and r05 Binanse at its single Inquisitor level, it drives
//   register/login (CSRF + Origin/Sec-Fetch-Site like a browser) -> catalog -> launch -> panel until running ->
//   open (single-use gate ticket -> hvwa_gate) -> the lab's landing page -> the reference solve (a node runner on the
//   instance's own internal network) -> flag submit -> score -> stop, and proves Divine resists every exploitable solve.
// It runs its OWN copy of docker-compose.range.yml in local mode: project hvwa-poc-e2e, its own external network
// hvwa-poc-e2e-edge with a TCP forwarder on 127.0.0.1:18081 standing in for cloudflared, plain HTTP, the portal at
// hvwa.localhost, instances at i-<id>.localhost, and the real pinned lab images from labs/registry.json.
// It refuses to start (changing nothing) when hvwa.range=1 containers or hvwa-i-* networks already exist on this engine.
// It always ends with `docker compose down -v` plus the removal of its forwarder, its edge network and every hvwa-i-*
// it made, and writes docs/poc-e2e-results.json + docs/poc-e2e-results.md. Exit 0 iff everything passed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './main-module.mjs';
import { labDirs, readManifest, RUNNER_IMAGE } from './lab-harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT = 'hvwa-poc-e2e';
const COMPOSE_FILE = join(root, 'docker-compose.range.yml');
const COMPOSE = ['compose', '-f', COMPOSE_FILE, '-p', PROJECT];
const EDGE_NETWORK = `${PROJECT}-edge`;
const TUNNEL = `${PROJECT}-tunnel`;
const TRAEFIK = `${PROJECT}-traefik`;
const HTTP_PORT = Number(process.env.HVWA_E2E_HTTP_PORT || 18081);
const RUNTIME = (process.env.HVWA_E2E_RUNTIME || 'runc').trim();
const PORTAL = 'hvwa.localhost';
const PASSWORD = 'Poc-Pass-1234';
const CAPACITY = '4';
const say = (msg) => console.log(`poc:e2e ${msg}`);

// Landing-page markers per lab (distinctive, flag-free). r03's <h1> is all-caps "BEACON".
const MARKER = Object.freeze({ r01: 'Mercy Clinic', r02: 'Courier', r03: 'BEACON', r04: 'Postcard', r05: 'Binanse' });
const FLAG_RE = /HVWA\{[a-z2-7]{26}\}/;

/** Every lab in labs/registry.json (id, levels, port) plus its solve directory, in registry order. */
function labs() {
  const registry = JSON.parse(readFileSync(join(root, 'labs', 'registry.json'), 'utf8'));
  const byId = new Map(labDirs().map((d) => [readManifest(d.path).id, d.path]));
  return registry.labs.map((l) => {
    const dir = byId.get(l.id);
    if (!dir) throw new Error(`no lab directory for ${l.id}`);
    return { ...l, solveDir: join(dir, 'solve') };
  });
}

// ------------------------------------------------------------------------------------------------ process helpers
const PARSE_ENV = Object.freeze({
  HVWA_EDGE_NETWORK: EDGE_NETWORK, HVWA_TRAEFIK_CONTAINER: TRAEFIK, HVWA_RANGE_DOMAIN: 'localhost',
  HVWA_ADMIN_PASSWORD: 'unused-unused', HVWA_WARDEN_SECRET: 'unused', HVWA_FORWARD_AUTH_SECRET: 'unused',
});
let env = { ...process.env, ...PARSE_ENV };
function run(cmd, args, { inherit = false, timeoutMs = 180_000 } = {}) {
  const r = spawnSync(cmd, args, { cwd: root, env, encoding: 'utf8', timeout: timeoutMs, stdio: inherit ? 'inherit' : 'pipe' });
  if (r.error) throw new Error(`${cmd} ${args.join(' ')}: ${r.error.message}`);
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
const show = (r) => `exit ${r.code}${r.out ? `, stdout: ${r.out.slice(0, 400)}` : ''}${r.err ? `, stderr: ${r.err.slice(0, 400)}` : ''}`;
function must(cmd, args, opts) {
  const r = run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${show(r)}`);
  return r.out;
}
const compose = (args, opts) => run('docker', [...COMPOSE, ...args], opts);
const exists = (kind, name) => run('docker', [kind, 'inspect', name]).code === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(what, fn, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch (err) { last = err; }
    await sleep(everyMs);
  }
  throw new Error(`${what}: not within ${timeoutMs} ms${last ? ` (last error: ${last.message})` : ''}`);
}

// ------------------------- HTTP through the tunnel stand-in on loopback, with an explicit Host (*.localhost, no DNS)
function hit(method, host, path, { headers = {}, body, jar } = {}) {
  return new Promise((resolve, reject) => {
    const cookie = jar ? jar.header(host) : '';
    const req = httpRequest({
      host: '127.0.0.1', port: HTTP_PORT, method, path, timeout: 30_000,
      headers: { host: `${host}:${HTTP_PORT}`, ...(cookie ? { cookie } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (d) => { text += d; }).on('end', () => {
        const setCookies = [res.headers['set-cookie'] ?? []].flat();
        if (jar) jar.take(host, setCookies);
        resolve({ status: res.statusCode, headers: res.headers, body: text, setCookies });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${host}${path} timed out`)));
    req.on('error', reject);
    req.end(body);
  });
}

/** Host-only cookies, as a browser keeps them for these hosts (none of ours ever has a Domain). */
function newJar() {
  const byHost = new Map();
  return {
    header: (host) => [...(byHost.get(host) ?? new Map())].map(([k, v]) => `${k}=${v}`).join('; '),
    take(host, lines) {
      const m = byHost.get(host) ?? new Map();
      for (const line of lines) {
        const [pair] = line.split(';');
        const eq = pair.indexOf('=');
        if (eq < 1) continue;
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim();
        if (v === '') m.delete(k); else m.set(k, v);
      }
      byHost.set(host, m);
    },
    get: (host, name) => byHost.get(host)?.get(name),
  };
}
const ORIGIN = `http://${PORTAL}:${HTTP_PORT}`;
/** A browser: host-only cookie jar, and form posts carrying the Origin + Sec-Fetch-Site a real browser sends. */
function browser(headers = {}) {
  const jar = newJar();
  return {
    jar,
    get: (host, path) => hit('GET', host, path, { jar, headers }),
    form: (host, path, fields, extra = {}) => hit('POST', host, path, {
      jar, headers: { ...headers, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded', ...extra },
      body: new URLSearchParams(fields).toString(),
    }),
  };
}
function csrfOf(html) {
  const v = /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
  if (!v) throw new Error('no _csrf field on the page');
  return v;
}

// ------------------------------------------------------------------------------------------------ the flows
const s = { launchMs: [] };
let ipCounter = 0;
function freshUser(labId, level) { return `poc_${labId}_${level}_${randomBytes(2).toString('hex')}`; }
/** One account per client IP per hour: each fresh user gets its own (trusted) CF-Connecting-IP, like a real range. */
function freshIp() { ipCounter += 1; return `203.0.113.${((ipCounter - 1) % 250) + 1}`; }

async function player(username) {
  const b = browser({ 'cf-connecting-ip': freshIp() });
  const page = await b.get(PORTAL, '/register');
  if (page.status !== 200) throw new Error(`GET /register -> ${page.status}`);
  const r = await b.form(PORTAL, '/register', { _csrf: csrfOf(page.body), username, password: PASSWORD, confirm: PASSWORD });
  if (r.status !== 303 || r.headers.location !== '/login?registered=1') throw new Error(`register ${username} -> ${r.status} ${r.headers.location ?? ''}`);
  const login = await b.get(PORTAL, '/login');
  const signed = await b.form(PORTAL, '/login', { _csrf: csrfOf(login.body), username, password: PASSWORD });
  if (signed.status !== 303) throw new Error(`sign-in of ${username} -> ${signed.status}`);
  const auth = signed.setCookies.find((l) => l.startsWith('hvwa_auth=')) ?? '';
  if (!/; HttpOnly/i.test(auth) || /domain=/i.test(auth)) throw new Error(`hvwa_auth is not host-only HttpOnly: ${auth}`);
  return b;
}
const panel = async (b, labId, level) => (await b.get(PORTAL, `/labs/${labId}/panel?level=${level}`)).body;
async function action(b, labId, name, level) {
  const page = await b.get(PORTAL, `/labs/${labId}?level=${level}`);
  return b.form(PORTAL, `/labs/${labId}/${name}`, { _csrf: csrfOf(page.body), level });
}
async function launch(b, labId, level) {
  const t0 = Date.now();
  const r = await action(b, labId, 'launch', level);
  if (r.status !== 303) throw new Error(`launch -> ${r.status}`);
  await poll(`the ${level} instance to run`, async () => /data-state="running"/.test(await panel(b, labId, level)), 90_000);
  return Date.now() - t0;
}
async function open(b, labId) {
  const page = await b.get(PORTAL, `/labs/${labId}`);
  const r = await b.form(PORTAL, `/labs/${labId}/open`, { _csrf: csrfOf(page.body) });
  if (r.status !== 303) throw new Error(`open -> ${r.status}`);
  const u = new URL(r.headers.location);
  if (u.protocol !== 'http:' || Number(u.port) !== HTTP_PORT || !/^i-[a-z2-7]{26}\.localhost$/.test(u.hostname)) throw new Error(`Open lab -> ${u.href}`);
  return { id: u.hostname.slice(2, -'.localhost'.length), host: u.hostname, gatePath: `${u.pathname}${u.search}` };
}
/** Follow an Open lab ticket, retrying while Traefik's Docker provider has not learned the new instance (its own 404). */
async function openLab(b, a) {
  let r;
  await poll(`Traefik to route ${a.host}`, async () => {
    r = await b.get(a.host, a.gatePath);
    return r.status !== 404;
  }, 30_000, 250);
  return r;
}
/** The run's one instance of `labId` at `level`, found through the Docker labels the warden put on it (hvwa.lab,
 *  hvwa.level -> hvwa.instance). Exactly one must exist: this run is sequential and preflight refused other ranges. */
function findInstance(labId, level) {
  const ids = must('docker', ['ps', '-q', '--filter', `label=hvwa.lab=${labId}`, '--filter', `label=hvwa.level=${level}`])
    .split(/\s+/).filter(Boolean);
  if (ids.length !== 1) {
    const detail = ids.map((cid) => {
      const r = run('docker', ['inspect', '--format',
        '{{.Name}} created={{.Created}} user={{index .Config.Labels "hvwa.user"}} instance={{index .Config.Labels "hvwa.instance"}}', cid]);
      return r.code === 0 ? r.out : cid;
    }).join(' | ');
    throw new Error(`expected exactly one ${labId}/${level} instance, found ${ids.length}: ${detail}`);
  }
  const instanceId = must('docker', ['inspect', '--format', '{{index .Config.Labels "hvwa.instance"}}', ids[0]]);
  if (!/^[a-z2-7]{26}$/.test(instanceId)) throw new Error(`the hvwa.instance label is not an instance id: ${instanceId}`);
  return instanceId;
}
/** The reference solve, as an attacker on the instance's own internal network (Traefik is the only other member). */
function runSolve(lab, solveLevel, instanceId, port) {
  return run('docker', ['run', '--rm', '--network', `hvwa-i-${instanceId}`, '--user', '10001:10001',
    '-v', `${lab.solveDir}:/solve:ro`, RUNNER_IMAGE, 'node', `/solve/${solveLevel}.mjs`, `http://hvwa-i-${instanceId}:${port}`]);
}
/**
 * r02's label route content-negotiates: at acolyte/templar, with Accept: text/html it answers the printable label
 * (status 200 and the label markup) for the demo-owned parcel 2001; at inquisitor/divine the route now requires an
 * API key, so the same bearer-only request must be 403. The private note is never printed or asserted here.
 */
function runCourierLabelCheck(instanceId, port, level) {
  const script = [
    "const base = process.argv[1];",
    "const level = process.argv[2];",
    "const { token } = await (await fetch(base + '/api/session', { method: 'POST' })).json();",
    "const r = await fetch(base + '/api/parcels/2001/label', { headers: { authorization: 'Bearer ' + token, accept: 'text/html' } });",
    "const body = await r.text();",
    "const want = level === 'acolyte' || level === 'templar' ? 200 : 403;",
    "if (r.status !== want) throw new Error('label -> ' + r.status + ' (want ' + want + ')');",
    "if (want === 200 && (!/^<!doctype html>/i.test(body) || !body.includes('Priority parcel label'))) throw new Error('not the printable label');",
    "process.stdout.write(want === 200 ? 'Accept: text/html is the printable label' : 'the label route is protected without an API key');",
  ].join('\n');
  return run('docker', ['run', '--rm', '--network', `hvwa-i-${instanceId}`, '--user', '10001:10001', RUNNER_IMAGE,
    'node', '--input-type=module', '-e', script, `http://hvwa-i-${instanceId}:${port}`, level]);
}
async function submit(b, labId, flag) {
  const page = await b.get(PORTAL, `/labs/${labId}`);
  return (await b.form(PORTAL, `/labs/${labId}/submit`, { _csrf: csrfOf(page.body), submission: flag }, { 'hx-request': 'true' })).body;
}

// ------------------------------------------------------------------------------------------------ one lab, one level
async function runLevel(lab, level, record) {
  const labId = lab.id;
  const mark = (name, ok, detail = '') => {
    record.checks.push({ name, ok, detail });
    say(`${ok ? 'PASS' : 'FAIL'} ${labId}/${level} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const st = { b: null, a: null, instanceId: null, flag: null };

  const steps = [
    ['register+login', async () => { st.b = await player(freshUser(labId, level)); }],
    ['catalog', async () => {
      const catalog = await st.b.get(PORTAL, '/');
      if (!catalog.body.includes(`data-testid="lab-card" data-lab="${labId}"`)) throw new Error('the catalog does not list the lab');
    }],
    ['launch', async () => {
      const ms = await launch(st.b, labId, level);
      record.launchMs = ms;
      st.instanceId = findInstance(labId, level);
      if (!exists('network', `hvwa-i-${st.instanceId}`)) throw new Error('the per-instance network is missing');
      return `ready in ${ms} ms (instance ${st.instanceId})`;
    }],
    ['open+gate', async () => {
      st.a = await open(st.b, labId);
      if (st.a.id !== st.instanceId) throw new Error(`the open ticket names ${st.a.id}, want ${st.instanceId}`);
      const gate = await openLab(st.b, st.a);
      if (gate.status !== 303 || gate.headers.location !== '/') throw new Error(`gate -> ${gate.status} ${gate.headers.location ?? ''}`);
      const line = gate.setCookies.find((l) => l.startsWith('hvwa_gate=')) ?? '';
      if (!line) throw new Error('no hvwa_gate cookie');
      if (!/; HttpOnly/i.test(line) || /domain=/i.test(line)) throw new Error(`hvwa_gate attributes: ${line}`);
    }],
    ['landing', async () => {
      const home = await st.b.get(st.a.host, '/');
      if (home.status !== 200) throw new Error(`the lab -> ${home.status}`);
      if (!home.body.includes(MARKER[labId])) throw new Error(`the landing page lacks ${JSON.stringify(MARKER[labId])}`);
      if (FLAG_RE.test(home.body)) throw new Error('the landing page contains a flag');
    }],
    ...(labId === 'r02' ? [['label-html', async () => {
      const r = runCourierLabelCheck(st.instanceId, lab.port, level);
      if (r.code !== 0) throw new Error(`the printable label check failed: ${show(r)}`);
      return r.out;
    }]] : []),
    ['gate-refused', async () => {
      const refused = await browser().get(st.a.host, '/');
      if (refused.status !== 401) throw new Error(`a request without the gate cookie -> ${refused.status}`);
    }],
    ...(level === 'divine'
      ? [['divine-resists', async () => {
          for (const sl of ['acolyte', 'templar', 'inquisitor']) {
            const r = runSolve(lab, sl, st.instanceId, lab.port);
            if (r.code !== 0) throw new Error(`the ${sl} solve did not run: ${show(r)}`);
            if (FLAG_RE.test(`${r.out}\n${r.err}`)) throw new Error(`the ${sl} solve printed a flag at Divine: ${r.out.slice(0, 80)}`);
          }
          return 'acolyte, templar and inquisitor print no flag';
        }]]
      : [
          ['solve', async () => {
            const r = runSolve(lab, level, st.instanceId, lab.port);
            if (r.code !== 0) throw new Error(`the ${level} solve did not run: ${show(r)}`);
            const m = r.out.match(FLAG_RE);
            if (!m) throw new Error(`the ${level} solve printed no flag (got ${JSON.stringify(r.out).slice(0, 80)})`);
            st.flag = m[0];
            return st.flag;
          }],
          ['submit', async () => {
            const body = await submit(st.b, labId, st.flag);
            if (!body.includes('data-solved="true"') || !body.includes('data-result="new_best"')) throw new Error(`submit -> ${body.slice(0, 200)}`);
            return 'new_best';
          }],
        ]),
    ['no-leak', async () => {
      const insp = run('docker', ['inspect', `hvwa-i-${st.instanceId}`]);
      if (FLAG_RE.test(`${insp.out}\n${insp.err}`)) throw new Error('docker inspect contains a flag');
      const ilogs = run('docker', ['logs', `hvwa-i-${st.instanceId}`]);
      if (FLAG_RE.test(`${ilogs.out}\n${ilogs.err}`)) throw new Error('docker logs contain a flag');
    }],
    ['stop', async () => {
      const stopped = await action(st.b, labId, 'stop', level);
      if (stopped.status !== 303) throw new Error(`stop -> ${stopped.status}`);
      await poll(`the ${level} instance to go`, async () => !exists('container', `hvwa-i-${st.instanceId}`), 30_000);
      if (exists('network', `hvwa-i-${st.instanceId}`)) throw new Error('the instance network is still there');
      st.instanceId = null;
      return 'container and network gone';
    }],
  ];

  for (const [name, fn] of steps) {
    try {
      const detail = await fn();
      mark(name, true, detail ?? '');
    } catch (err) {
      mark(name, false, err instanceof Error ? err.message : String(err));
      break;
    }
  }

  // Never leave this level's instance behind, whatever happened above.
  if (st.instanceId) {
    try { await action(st.b, labId, 'stop', level); } catch { /* best effort */ }
    try { run('docker', ['rm', '-f', `hvwa-i-${st.instanceId}`]); } catch { /* best effort */ }
    try { run('docker', ['network', 'rm', `hvwa-i-${st.instanceId}`]); } catch { /* best effort */ }
  }
}

// ------------------------------------------------------------------------------------------------ run
let tmp = '';
let started = false;
let preflighted = false;

async function portFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

function removeOwnLeftovers() {
  run('docker', ['rm', '-f', TUNNEL]);
  compose(['down', '-v'], { timeoutMs: 180_000 });
  run('docker', ['network', 'rm', EDGE_NETWORK]);
}

async function preflight() {
  must('docker', ['version', '--format', '{{.Server.Version}}']);
  removeOwnLeftovers(); // of an interrupted run of THIS script only (its project, forwarder and network names)
  const ranges = run('docker', ['ps', '-aq', '--filter', 'label=hvwa.range=1']).out;
  const nets = run('docker', ['network', 'ls', '-q', '--filter', 'name=hvwa-i-']).out;
  if (ranges || nets) {
    throw new Error('BLOCKED: hvwa.range=1 containers or hvwa-i-* networks already exist on this engine (another range?); '
      + 'refusing to start (nothing was changed)');
  }
  if (!(await portFree(HTTP_PORT))) throw new Error(`BLOCKED: 127.0.0.1:${HTTP_PORT} is in use (set HVWA_E2E_HTTP_PORT)`);
  preflighted = true;
}

async function main() {
  await preflight();
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  for (const tag of [`sigmajo/hvwa:range-portal-${version}`, `sigmajo/hvwa:range-warden-${version}`, RUNNER_IMAGE]) {
    if (run('docker', ['image', 'inspect', tag]).code !== 0) throw new Error(`image ${tag} is missing (run \`npm run range:build\`, or pull it)`);
  }
  const secrets = {
    admin: randomBytes(12).toString('base64url'),
    warden: randomBytes(32).toString('hex'),
    forward: randomBytes(32).toString('hex'),
  };
  env = {
    ...process.env, ...PARSE_ENV, HVWA_RANGE_VERSION: version,
    HVWA_PORTAL_HOST: PORTAL, HVWA_RANGE_PUBLIC_SCHEME: 'http', HVWA_RANGE_PUBLIC_PORT: String(HTTP_PORT),
    HVWA_ADMIN_PASSWORD: secrets.admin, HVWA_WARDEN_SECRET: secrets.warden, HVWA_FORWARD_AUTH_SECRET: secrets.forward,
    HVWA_RANGE_KEY: '', HVWA_RANGE_CAPACITY: CAPACITY, HVWA_REGISTRATION_OPEN: '1', HVWA_LAB_REGISTRY_FILE: join(root, 'labs', 'registry.json'),
    HVWA_RANGE_RUNTIME: RUNTIME,
  };
  started = true;
  must('docker', ['network', 'create', EDGE_NETWORK]); // stands in for the owner's hvwa-edge
  say(`starting: docker compose -f docker-compose.range.yml -p ${PROJECT} up -d --wait (runtime ${RUNTIME})`);
  const up = compose(['up', '-d', '--wait', '--wait-timeout', '240'], { inherit: true, timeoutMs: 900_000 });
  if (up.code !== 0) throw new Error(`docker compose up failed (exit ${up.code})`);
  // The tunnel stand-in: what cloudflared does on the server (a plain TCP hop to traefik:80), on loopback only.
  const forwarder = "const n=require('node:net');n.createServer((c)=>{const u=n.connect(80,'traefik');c.pipe(u).pipe(c);"
    + "c.on('error',()=>u.destroy());u.on('error',()=>c.destroy())}).listen(8080)";
  must('docker', ['run', '-d', '--name', TUNNEL, '--network', EDGE_NETWORK, '-p', `127.0.0.1:${HTTP_PORT}:8080`, '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', `sigmajo/hvwa:range-portal-${version}`, 'node', '-e', forwarder]);
  await poll('the portal through the tunnel stand-in', async () => (await hit('GET', PORTAL, '/healthz')).status === 200, 60_000);

  const all = labs();
  const summary = { schema: 1, project: PROJECT, runtime: RUNTIME, generatedAt: new Date().toISOString(), labs: [] };
  for (const lab of all) {
    const entry = { id: lab.id, app: lab.app, levels: [] };
    summary.labs.push(entry);
    for (const level of lab.levels) {
      const record = { level, ok: true, launchMs: null, checks: [] };
      entry.levels.push(record);
      await runLevel(lab, level, record);
      record.ok = record.checks.every((c) => c.ok);
    }
  }
  return { summary };
}

function writeResults(summary) {
  const ok = summary.labs.flatMap((l) => l.levels).every((lv) => lv.ok);
  summary.ok = ok;
  const jsonPath = join(root, 'docs', 'poc-e2e-results.json');
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
  const rows = summary.labs.flatMap((l) => l.levels.map((lv) => {
    const passed = lv.checks.filter((c) => c.ok).length;
    return `| ${l.id} ${l.app} | ${lv.level} | ${lv.ok ? 'PASS' : 'FAIL'} | ${lv.launchMs === null ? '—' : lv.launchMs} | ${passed}/${lv.checks.length} |`;
  }));
  const md = [
    '# HVWA Range POC — end-to-end results',
    '',
    `Generated ${summary.generatedAt} (project \`${PROJECT}\`, runtime \`${RUNTIME}\`).`,
    '',
    '| Lab | Level | Result | Launch→ready (ms) | Checks |',
    '| --- | ----- | ------ | ------------------ | ------ |',
    ...rows,
    '',
    `**Overall: ${ok ? 'PASS' : 'FAIL'}** — every real lab works through the portal at every level${ok ? ' and Divine resists' : ''}.`,
    '',
  ].join('\n');
  writeFileSync(join(root, 'docs', 'poc-e2e-results.md'), `${md}\n`);
  return ok;
}

function cleanup() {
  if (!preflighted) return;
  say('stopping: the forwarder, docker compose down -v, the edge network, and every hvwa-i-* this run made');
  try {
    removeOwnLeftovers();
    const left = run('docker', ['ps', '-aq', '--filter', 'label=hvwa.range=1']).out.split(/\s+/).filter(Boolean);
    if (left.length) run('docker', ['rm', '-f', ...left]);
    const nets = run('docker', ['network', 'ls', '-q', '--filter', 'name=hvwa-i-']).out.split(/\s+/).filter(Boolean);
    if (nets.length) run('docker', ['network', 'rm', ...nets]);
    run('docker', ['network', 'rm', EDGE_NETWORK]); // again: it is free only once every hvwa-i-* endpoint is gone
  } catch (err) {
    say(`cleanup: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  started = false;
  tmp = '';
}

if (isMainModule(process.argv[1], import.meta.url)) {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(signal, () => { say(`${signal}: interrupted, cleaning up`); cleanup(); process.exit(code); });
  }
  main().then(
    ({ summary }) => {
      const ok = writeResults(summary);
      cleanup();
      if (ok) say('OK — every real lab works through the portal at every level, and Divine resists');
      else { console.error('poc:e2e FAILED — see docs/poc-e2e-results.md'); process.exitCode = 1; }
    },
    (err) => { cleanup(); console.error(`poc:e2e FAILED: ${err instanceof Error ? err.message : String(err)}`); process.exitCode = 1; },
  );
}
