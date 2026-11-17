// scripts/verify-docker.mjs — `npm run verify:docker` (NOT part of `npm test`;
// needs a running Docker engine). Builds and starts the hardened compose stack,
// then checks from the outside that the isolation really holds: HTTP through
// the loopback-only proxy, a non-root app on a read-only rootfs, NO egress from
// the app, data surviving a restart. Ends with `docker compose down` (the data
// volume is kept). Exit code 0 = every check passed.
//
// HVWA_COMPOSE_FILE=docker-compose.hub.yml checks the pull-only stack instead
// (the published image, e.g. a freshly built sigmajo/hvwa:lite, and the inline
// proxy config). The platform login is ON in the image: the HTTP checks sign in
// as admin with HVWA_ADMIN_PASSWORD (default: the default password).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect, createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 1337;
const BASE = `http://127.0.0.1:${PORT}`;
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.hub.yml'];
const COMPOSE_NAME = (process.env.HVWA_COMPOSE_FILE ?? '').trim() || 'docker-compose.yml';
if (!COMPOSE_FILES.includes(COMPOSE_NAME)) {
  throw new Error(`verify:docker: HVWA_COMPOSE_FILE must be one of ${COMPOSE_FILES.join(', ')} (got "${COMPOSE_NAME}")`);
}
/** The pull-only stack: no build, the proxy's nginx.conf inline (written to its /tmp at start). */
const HUB = COMPOSE_NAME === 'docker-compose.hub.yml';
const COMPOSE_FILE = join(root, COMPOSE_NAME);
// Every compose call names the file AND the project explicitly, so `down`,
// `restart` etc. can only ever touch HVWA's own containers/networks — never
// another compose project on this machine.
const COMPOSE = ['compose', '-f', COMPOSE_FILE, '-p', 'hvwa'];
const say = (msg) => console.log(`verify:docker ${msg}`);

// The persisted-secret path (/data/flag-secret) and the loopback-only Host
// allowlist are part of what is checked, so FLAG_SECRET / HVWA_ALLOWED_HOSTS
// from the developer's .env or shell must not apply to this run (shell env
// beats .env in compose interpolation; blank means "unset").
// The login is checked as the image ships it (on): HVWA_AUTH is blanked too.
// HVWA_ADMIN_PASSWORD comes from this shell only (blank beats a .env value), so the
// first password compose hands a fresh volume is the one the checks sign in with.
/** The admin password the HTTP checks sign in with (a kept data volume may hold a changed one). */
const ADMIN_PASSWORD = process.env.HVWA_ADMIN_PASSWORD || 'password';
const env = {
  ...process.env, FLAG_SECRET: '', HVWA_ALLOWED_HOSTS: '', HVWA_AUTH: '', HVWA_ADMIN_PASSWORD: process.env.HVWA_ADMIN_PASSWORD ?? '',
};
// The proxy's own 421 body carries this marker; the app's never does.
const PROXY_421 = 'HVWA proxy';

/** Run a command in the project root; never throws on a non-zero exit. */
function run(cmd, args, { inherit = false, timeoutMs = 120_000 } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root, env, encoding: 'utf8', timeout: timeoutMs, stdio: inherit ? 'inherit' : 'pipe',
  });
  if (r.error) throw new Error(`${cmd} ${args.join(' ')}: ${r.error.message}`);
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
const compose = (args, opts) => run('docker', [...COMPOSE, ...args], opts);
const exec = (service, argv) => compose(['exec', '-T', service, ...argv]);
const show = (r) => `exit ${r.code}${r.out ? `, stdout: ${r.out}` : ''}${r.err ? `, stderr: ${r.err}` : ''}`;

function containerId(service) {
  const r = compose(['ps', '-q', service]);
  if (r.code !== 0 || !r.out) throw new Error(`no running container for service ${service} (${show(r)})`);
  return r.out.split(/\r?\n/)[0];
}
function inspect(kind, id) {
  const r = run('docker', [kind, 'inspect', id]);
  if (r.code !== 0) throw new Error(`docker ${kind} inspect ${id}: ${show(r)}`);
  return JSON.parse(r.out)[0];
}

// A tiny cookie jar, so the plain GETs behave like a browser: hvwa_sid (and any other Set-Cookie)
// from the first response is sent on every later one. Without it every request mints a NEW session
// and trips the app's new-session issuance limit (60/min) once enough challenges are registered.
// (Requests with an explicit Host or raw sockets below are deliberately cookie-less probes.)
const jar = new Map();
const sidsSeen = new Set();
const MAX_SIDS = 2; // one for the whole run; one spare
function remember(setCookies) {
  for (const line of setCookies) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === '') jar.delete(name); // a cleared cookie (logout)
    else jar.set(name, value);
    if (name === 'hvwa_sid') sidsSeen.add(value);
  }
}
async function get(path, init = {}) {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(BASE + path, {
    ...init, signal: AbortSignal.timeout(10_000), redirect: 'manual', headers: { ...init.headers, ...(cookie ? { cookie } : {}) },
  });
  remember(res.headers.getSetCookie());
  return { status: res.status, location: res.headers.get('location'), body: await res.text() };
}
/** POST an urlencoded form through the jar. */
const postForm = (path, fields) => get(path, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(),
});
const csrfOf = (html) => {
  const v = /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
  if (!v) throw new Error('no _csrf field on the page');
  return v;
};
async function expect200(path) {
  const r = await get(path);
  if (r.status !== 200) throw new Error(`GET ${path} -> ${r.status}`);
  return r.body;
}

/** A request through the published port with an explicit Host header (fetch cannot set Host). */
function send(method, path, host, headers = {}, body = undefined) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: PORT, method, path, headers: { ...headers, host }, timeout: 30_000 }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (d) => { text += d; }).on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${path} (Host ${host}) timed out`)));
    req.on('error', reject);
    req.end(body);
  });
}
const getWithHost = (path, host, headers = {}) => send('GET', path, host, headers);

// An upstream that answers every request with what it received. verify:docker
// swaps it in for the app (same service config and network alias) to see
// exactly what the proxy forwards.
const ECHO_NAME = 'hvwa-verify-echo';
const ECHO_JS = 'require("node:http").createServer((q,s)=>{let n=0;q.on("data",(d)=>{n+=d.length});' +
  'q.on("end",()=>{s.setHeader("content-type","application/json");s.end(JSON.stringify(' +
  '{hvwaEcho:true,method:q.method,url:q.url,headers:q.headers,bytes:n}))})}).listen(1337,"0.0.0.0")';

async function poll(what, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch (err) { last = err; }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} within ${timeoutMs} ms${last ? ` (last error: ${last.message})` : ''}`);
}
const isEcho = async () => JSON.parse((await getWithHost('/__echo', 'localhost:1337')).body).hvwaEcho === true;
const isApp = async () => JSON.parse((await getWithHost('/healthz', 'localhost:1337')).body).status === 'ok';

// Set when a check leaves the stack in a state the remaining checks cannot use;
// they are then reported as SKIP with this reason instead of failing confusingly.
let brokenStack = '';

/**
 * Run `fn` while the echo server stands in for the app, then restore the real
 * app. If the restore fails, the stack is marked broken, and the error
 * reports BOTH fn's failure (if any) and the restore failure.
 */
async function withEchoUpstream(fn) {
  const stop = compose(['stop', 'app']);
  if (stop.code !== 0) throw new Error(`docker compose stop app: ${show(stop)}`);
  let result;
  let failure;
  try {
    run('docker', ['rm', '-f', ECHO_NAME]);
    const r = compose(['run', '-d', '--no-deps', '--use-aliases', '--name', ECHO_NAME, 'app', 'node', '-e', ECHO_JS]);
    if (r.code !== 0) throw new Error(`starting the echo upstream: ${show(r)}`);
    await poll('the proxy did not reach the echo upstream', isEcho, 45_000); // nginx re-resolves `app` every 10 s
    result = await fn();
  } catch (err) {
    failure = err;
  }
  try {
    run('docker', ['rm', '-f', ECHO_NAME]);
    const start = compose(['start', 'app']);
    if (start.code !== 0) throw new Error(`docker compose start app: ${show(start)}`);
    await waitHealthy('app', 60_000);
    await poll('the proxy did not reach the restored app', isApp, 45_000);
  } catch (err) {
    brokenStack = `the real app was not restored after the echo check (${err.message})`;
    throw new Error(failure ? `${failure.message} — AND ${brokenStack}` : brokenStack);
  }
  if (failure) throw failure;
  return result;
}

/** Parse a raw HTTP/1.x response: status, whether it sets a cookie, body. */
const parseRaw = (text) => {
  const split = text.indexOf('\r\n\r\n');
  const head = split === -1 ? text : text.slice(0, split);
  return {
    status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1]),
    setCookie: /^set-cookie:/im.test(head),
    body: split === -1 ? '' : text.slice(split + 4),
  };
};

/** Send raw request bytes to the published port (duplicate Host, absolute-form...). Keeps the socket open until the server closes it. */
function rawThroughProxy(head) {
  return new Promise((resolve, reject) => {
    let text = '';
    const s = connect(PORT, '127.0.0.1', () => s.write(`${head}\r\nConnection: close\r\n\r\n`));
    s.setTimeout(10_000, () => s.destroy(new Error(`raw request timed out: ${head.split('\r\n')[0]}`)));
    s.setEncoding('utf8').on('data', (d) => { text += d; });
    s.on('error', reject).on('close', () => resolve(parseRaw(text)));
  });
}

/** The same, sent from INSIDE the app container straight to the app (no proxy). */
function rawToApp(head) {
  const script = 'const s=require("node:net").connect(1337,"127.0.0.1",()=>s.write(' +
    `${JSON.stringify(`${head}\r\nConnection: close\r\n\r\n`)}));let t="";s.setTimeout(5000,()=>{s.destroy();process.exit(3)});` +
    's.setEncoding("utf8").on("data",(d)=>{t+=d}).on("close",()=>{process.stdout.write(t);process.exit(0)}).on("error",()=>process.exit(3))';
  const r = run('docker', [...COMPOSE, 'exec', '-T', 'app', 'node', '-e', script]);
  if (r.code !== 0) throw new Error(`in-container raw request failed (${show(r)})`);
  return parseRaw(r.out);
}

/** Status of GET http://127.0.0.1:1337/healthz with Host `host`, sent from INSIDE the app container (bypasses the proxy). */
function appStatusFor(host) {
  const r = exec('app', ['node', '-e',
    `require('node:http').get({host:'127.0.0.1',port:1337,path:'/healthz',headers:{host:${JSON.stringify(host)}},timeout:5000},` +
    '(res)=>{console.log(res.statusCode);process.exit(0)})' +
    '.on(\'timeout\',function(){this.destroy(new Error(\'TIMEOUT\'))})' +
    '.on(\'error\',(e)=>{console.log(e.code||e.message);process.exit(3)})']);
  if (r.code !== 0) throw new Error(`in-container request with Host ${host} failed (${show(r)})`);
  return Number(r.out);
}

/**
 * A node one-liner run INSIDE the app container: fetch(url) with a 5 s
 * timeout. Exit 0 = the request got an HTTP response, 3 = it failed at the
 * network level (prints the error code). Any other exit (e.g. 125/126 from
 * `docker compose exec` itself) is "the probe did not run", never a pass.
 */
const probe = (url) => ['node', '-e',
  `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(5000)}).then(()=>process.exit(0),` +
  '(e)=>{console.log(String(e.cause?.code??e.cause?.message??e.name));process.exit(3)})'];

// Only these outcomes mean "no path": nothing answered at all. A refusal or a
// reset means a host stack DID answer, so the target is reachable. Anything
// unrecognised fails closed.
const BLOCKED = new Set(['ETIMEDOUT', 'TIMEOUT', 'TimeoutError', 'AbortError', 'ENETUNREACH', 'EHOSTUNREACH',
  'EAI_AGAIN', 'ENOTFOUND', 'EAI_FAIL', 'EAI_NONAME']);
const REACHED = new Set(['CONNECTED', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
function blockedOrThrow(target, outcome) {
  if (BLOCKED.has(outcome)) return outcome;
  if (REACHED.has(outcome)) throw new Error(`the app reached ${target} (${outcome}: something answered)`);
  throw new Error(`unexpected outcome for ${target}: ${outcome || '(none)'} — treated as reachable`);
}

function expectBlocked(url) {
  const r = exec('app', probe(url));
  if (r.code === 0) throw new Error(`the app reached ${url} — egress is NOT blocked`);
  if (r.code !== 3) throw new Error(`egress probe for ${url} did not run (${show(r)})`);
  return blockedOrThrow(url, r.out);
}

/**
 * TCP-connect from INSIDE the app container to every host:port in `targets`
 * (3 s each, in parallel). Returns { "host:port": outcome } where outcome is
 * CONNECTED, TIMEOUT or the socket error code.
 */
function tcpProbe(targets) {
  const script = `const net=require('node:net');const t=${JSON.stringify(targets)};` +
    'Promise.all(t.map(([h,p])=>new Promise((r)=>{const s=net.connect({host:h,port:p});s.setTimeout(3000);' +
    's.once(\'connect\',()=>{s.destroy();r(\'CONNECTED\')});s.once(\'timeout\',()=>{s.destroy();r(\'TIMEOUT\')});' +
    's.once(\'error\',(e)=>r(e.code||e.message))}))).then((o)=>{console.log(JSON.stringify(Object.fromEntries(' +
    't.map(([h,p],i)=>[h+\':\'+p,o[i]]))));process.exit(0)})';
  const r = exec('app', ['node', '-e', script]);
  if (r.code !== 0) throw new Error(`TCP probe did not run (${show(r)})`);
  return JSON.parse(r.out);
}

const ipToInt = (ip) => ip.split('.').reduce((acc, o) => (acc * 256) + Number(o), 0);
const intToIp = (v) => [24, 16, 8, 0].map((s) => (v >>> s) & 255).join('.');
/** a.b.c.d/n -> { network, size } as integers. */
function subnetOf(cidr) {
  const [ip, bits] = cidr.split('/');
  const size = 2 ** (32 - Number(bits));
  return { network: Math.floor(ipToInt(ip) / size) * size, size };
}
/** The first host address of the subnet (where a bridge gateway would sit). */
const firstHost = (cidr) => intToIp(subnetOf(cidr).network + 1);
/** Up to two host addresses in the subnet that no container holds (the middle and the last one). */
function unusedHosts(cidr, held) {
  const { network, size } = subnetOf(cidr);
  if (size < 8) return [];
  return [...new Set([network + Math.floor(size / 2), network + size - 2])]
    .map(intToIp).filter((ip) => !held.has(ip) && ip !== firstHost(cidr));
}

/** The app's only network (the internal `lab`), inspected. */
function labNetwork() {
  const nets = Object.keys(inspect('container', containerId('app')).NetworkSettings.Networks ?? {});
  if (nets.length !== 1) throw new Error(`app should be on exactly one network, is on: ${nets.join(', ') || 'none'}`);
  return inspect('network', nets[0]);
}

async function waitHealthy(service, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const r = compose(['ps', '-q', service]);
    if (r.code === 0 && r.out) {
      last = inspect('container', r.out.split(/\r?\n/)[0]).State?.Health?.Status ?? 'no healthcheck';
      if (last === 'healthy') return;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`${service} not healthy within ${timeoutMs} ms (last status: ${last || 'no container'})`);
}

const readSecret = () => {
  const r = exec('app', ['cat', '/data/flag-secret']);
  if (r.code !== 0 || r.out.length < 16) throw new Error(`/data/flag-secret unreadable or too short (${show(r)})`);
  return r.out;
};
const dataFilesExist = () => {
  for (const f of ['/data/hvwa.db', '/data/flag-secret']) {
    const r = exec('app', ['test', '-f', f]);
    if (r.code !== 0) throw new Error(`${f} does not exist (${show(r)})`);
  }
};

/** Hardening that must hold for every service (read from the running containers). */
function checkHostConfig(service) {
  const c = inspect('container', containerId(service));
  const h = c.HostConfig;
  const problems = [];
  if (h.ReadonlyRootfs !== true) problems.push('rootfs not read-only');
  if (!(h.CapDrop ?? []).map((x) => x.toUpperCase()).some((x) => x === 'ALL' || x === 'CAP_ALL')) problems.push('CapDrop lacks ALL');
  if ((h.CapAdd ?? []).length > 0) problems.push(`CapAdd ${h.CapAdd.join(',')}`);
  if (!(h.SecurityOpt ?? []).some((o) => /^no-new-privileges(:true|=true)?$/.test(o))) problems.push('no no-new-privileges');
  if (h.Privileged) problems.push('privileged');
  if (!(h.PidsLimit > 0)) problems.push('no pids limit');
  if (!(h.Memory > 0)) problems.push('no memory limit');
  if (!(h.NanoCpus > 0)) problems.push('no cpu limit');
  if (problems.length) throw new Error(`${service}: ${problems.join('; ')}`);
  return `read-only rootfs, cap_drop ALL, no-new-privileges, pids ${h.PidsLimit}, mem ${h.Memory / 2 ** 20} MiB, cpus ${h.NanoCpus / 1e9}`;
}

const checks = [
  ['GET /healthz through the proxy -> 200', async () => {
    const body = await expect200('/healthz');
    if (JSON.parse(body).status !== 'ok') throw new Error(`/healthz body ${body}`);
    return body;
  }],
  ['the platform login gates the lab (signed out: 303 /login, /api 401) and admin signs in', async () => {
    const gated = await get('/');
    if (gated.status !== 303 || gated.location !== '/login?next=%2F') {
      throw new Error(`signed out, GET / -> ${gated.status} ${gated.location ?? ''} (expected 303 to /login?next=%2F: is the login on?)`);
    }
    const api = await get('/api/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (api.status !== 401) throw new Error(`signed out, POST /api/submit -> ${api.status} (expected 401)`);
    const page = await get('/login');
    if (page.status !== 200) throw new Error(`GET /login -> ${page.status}`);
    const res = await postForm('/login', { _csrf: csrfOf(page.body), username: 'admin', password: ADMIN_PASSWORD, next: '/' });
    if (res.status !== 303 || !jar.get('hvwa_auth')) {
      throw new Error(`could not sign in as admin (POST /login -> ${res.status}). The kept data volume may hold a changed ` +
        'password: run with HVWA_ADMIN_PASSWORD=<it>, or reset with docker compose -p hvwa down -v');
    }
    return `303 /login and 401 while signed out; admin signed in${process.env.HVWA_ADMIN_PASSWORD ? '' : ' with the default password'}`;
  }],
  ['GET / -> 200 and every linked /c/<id> challenge page -> 200 (exactly 5 in the lite edition)', async () => {
    const index = await expect200('/');
    const ids = [...new Set([...index.matchAll(/href="\/c\/([A-Z]{2}-\d{2})"/g)].map((m) => m[1]))];
    if (ids.length === 0) throw new Error('the portal index links no /c/<id> challenge');
    for (const id of ids) {
      const page = await expect200(`/c/${id}`);
      if (!page.includes(id)) throw new Error(`/c/${id} does not mention ${id}`);
    }
    // The edition is baked into the image (Dockerfile ARG/ENV HVWA_EDITION).
    const appEnv = inspect('container', containerId('app')).Config?.Env ?? [];
    const edition = appEnv.find((e) => e.startsWith('HVWA_EDITION='))?.slice('HVWA_EDITION='.length) || 'full';
    if (edition === 'lite' && ids.length !== 5) throw new Error(`the lite image serves ${ids.length} challenge(s), expected 5`);
    // Guard: a client that keeps its cookie jar is handed ONE session.
    if (sidsSeen.size > MAX_SIDS) {
      throw new Error(`the app handed out ${sidsSeen.size} distinct hvwa_sid values (max ${MAX_SIDS}): the cookie jar is not being sent`);
    }
    // Runtime assets: the --omit=dev image must still carry htmx.org (a prod dependency).
    for (const asset of ['/static/app.css', '/static/vendor/htmx.min.js']) await expect200(asset);
    return `edition ${edition}: ${ids.length} challenge page(s): ${ids.join(', ')}; static assets served; ${sidsSeen.size} hvwa_sid issued`;
  }],
  ['Host allowlist (DNS rebinding): loopback names pass, others get 421 at the proxy AND the app', async () => {
    for (const host of ['localhost:1337', '127.0.0.1:1337', 'LOCALHOST:1337', '[::1]:1337']) {
      const r = await getWithHost('/healthz', host);
      if (r.status !== 200) throw new Error(`Host ${host} through the proxy -> ${r.status}, expected 200`);
    }
    const xfh = await getWithHost('/healthz', 'localhost:1337', { 'x-forwarded-host': 'evil.example' });
    if (xfh.status !== 200) throw new Error(`X-Forwarded-Host changed the decision (-> ${xfh.status})`);
    for (const host of ['evil.example', 'evil.example:1337', '127.0.0.1.evil.example:1337', 'localhost.evil.example']) {
      for (const path of ['/healthz', '/']) {
        const r = await getWithHost(path, host);
        if (r.status !== 421) throw new Error(`Host ${host} GET ${path} through the proxy -> ${r.status}, expected 421`);
        // The proxy's own body proves the request was answered there and never reached the app.
        if (!r.body.includes(PROXY_421)) throw new Error(`Host ${host}: 421 did not come from the proxy (body: ${r.body.slice(0, 120)})`);
      }
    }
    // Defense in depth: straight to the app inside the lab network, no proxy involved.
    const appEvil = appStatusFor('evil.example');
    if (appEvil !== 421) throw new Error(`the app itself answered Host evil.example with ${appEvil}, expected 421`);
    const appOk = appStatusFor('localhost:1337');
    if (appOk !== 200) throw new Error(`the app itself answered Host localhost:1337 with ${appOk}, expected 200`);
    return 'localhost/127.0.0.1/[::1] -> 200; evil.example & co -> 421 from the proxy; app alone: evil.example -> 421';
  }],
  ['ambiguous Host: duplicates -> 400, absolute-form targets must name an allowed host (proxy AND app)', async () => {
    const problems = [];
    const expectRaw = (where, r, status, extra = () => undefined) => {
      if (r.status !== status) problems.push(`${where} -> ${r.status}, expected ${status}`);
      else if (r.setCookie) problems.push(`${where} -> ${status} but set a cookie (reached the session middleware)`);
      else { const e = extra(r); if (e) problems.push(`${where}: ${e}`); }
    };
    for (const [a, b] of [['localhost:1337', 'evil.example'], ['evil.example', 'localhost:1337']]) {
      const head = `GET /healthz HTTP/1.1\r\nHost: ${a}\r\nHost: ${b}`;
      expectRaw(`proxy: Host ${a} + Host ${b}`, await rawThroughProxy(head), 400);
      expectRaw(`app: Host ${a} + Host ${b}`, rawToApp(head), 400,
        (r) => (r.body.includes('evil.example') ? 'the 400 echoes the Host' : undefined));
    }
    // The authority in an absolute-form target overrides Host: it must be allowed too.
    const evilTarget = 'GET http://evil.example/healthz HTTP/1.1\r\nHost: localhost:1337';
    expectRaw('proxy: GET http://evil.example/ + Host localhost', await rawThroughProxy(evilTarget), 421,
      (r) => (r.body.includes(PROXY_421) ? undefined : 'not answered by the proxy'));
    expectRaw('app: GET http://evil.example/ + Host localhost', rawToApp(evilTarget), 421);
    // An allowed target with a foreign Host: the proxy picks the server from the target,
    // forwards the client's Host, and the app fails closed.
    expectRaw('proxy: GET http://localhost:1337/ + Host evil.example',
      await rawThroughProxy('GET http://localhost:1337/healthz HTTP/1.1\r\nHost: evil.example'), 421,
      (r) => (r.body.includes(PROXY_421) ? 'expected the app to answer' : undefined));
    if (problems.length) throw new Error(problems.join('; '));
    return 'duplicate Host -> 400 (proxy and app, both orders); absolute-form evil target -> 421 (proxy and app); ' +
      'allowed target + evil Host -> 421 from the app; no cookies on any of them';
  }],
  ['published port is loopback-only; the app publishes nothing', () => {
    const r = compose(['port', 'proxy', '8080']);
    if (r.code !== 0 || !r.out.startsWith('127.0.0.1:')) throw new Error(`docker compose port proxy 8080: ${show(r)}`);
    const bindings = Object.values(inspect('container', containerId('proxy')).HostConfig.PortBindings ?? {}).flat();
    const exposed = bindings.filter((b) => b?.HostIp !== '127.0.0.1');
    if (exposed.length) throw new Error(`proxy binds non-loopback host IPs: ${JSON.stringify(exposed)}`);
    const app = Object.values(inspect('container', containerId('app')).HostConfig.PortBindings ?? {}).flat();
    if (app.length) throw new Error(`app publishes ports: ${JSON.stringify(app)}`);
    return r.out;
  }],
  ['app and proxy processes are non-root', () => {
    const out = [];
    for (const service of ['app', 'proxy']) {
      const r = exec(service, ['id', '-u']);
      if (r.code !== 0 || !/^\d+$/.test(r.out) || r.out === '0') throw new Error(`${service}: id -u ${show(r)}`);
      out.push(`${service} uid ${r.out}`);
    }
    return out.join(', ');
  }],
  ['app rootfs is read-only (only /tmp and /data are writable)', () => {
    const x = exec('app', ['sh', '-c', 'touch /x']);
    if (x.code === 0) throw new Error('touch /x succeeded');
    // As non-root, `touch /x` fails even on a writable rootfs; the app user's
    // own home dir proves the failure is the read-only mount.
    const home = exec('app', ['sh', '-c', 'touch "$HOME/.probe"']);
    if (home.code === 0 || !/read-only/i.test(home.err + home.out)) throw new Error(`touch $HOME/.probe: ${show(home)}`);
    for (const dir of ['/tmp', '/data']) {
      const w = exec('app', ['sh', '-c', `touch ${dir}/.probe && rm ${dir}/.probe`]);
      if (w.code !== 0) throw new Error(`${dir} is not writable: ${show(w)}`);
    }
    return `touch /x: ${x.err || `exit ${x.code}`}`;
  }],
  ['the app image carries node only: no npm, npx, yarn or corepack', () => {
    const r = exec('app', ['sh', '-c',
      'for t in npm npx yarn yarnpkg corepack; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done; ' +
      'ls -d /usr/local/lib/node_modules/* /opt/yarn-* 2>/dev/null; node --version']);
    const lines = r.out.split(/\r?\n/).filter(Boolean);
    const node = lines.pop();
    if (r.code !== 0 || !/^v\d+\./.test(node ?? '')) throw new Error(`probe failed (${show(r)})`);
    if (lines.length) throw new Error(`still present: ${lines.join(', ')}`);
    return `node ${node} only`;
  }],
  ['the image ships docker-compose.hub.yml (for pull-only users), identical to the repo file', () => {
    const r = exec('app', ['cat', '/app/docker-compose.hub.yml']);
    const want = readFileSync(join(root, 'docker-compose.hub.yml'), 'utf8').replace(/\r\n/g, '\n').trim();
    if (r.code !== 0) throw new Error(`cat /app/docker-compose.hub.yml: ${show(r)}`);
    if (r.out.replace(/\r\n/g, '\n') !== want) throw new Error('/app/docker-compose.hub.yml differs from the repo file (rebuild the image)');
    return `/app/docker-compose.hub.yml, ${want.length} characters`;
  }],
  ['hardening flags on every container', () =>
    ['app', 'proxy'].map((s) => `${s}: ${checkHostConfig(s)}`).join(' | ')],
  [`mounts: app = data volume + noexec /tmp (+ init), proxy = ${HUB ? 'no mounts, nginx.conf inline' : 'read-only nginx.conf'} + noexec tmpfs; no Docker socket`, () => {
    const app = inspect('container', containerId('app'));
    const proxy = inspect('container', containerId('proxy'));
    const problems = [];
    if (app.HostConfig.Init !== true) problems.push('app: init is not enabled');
    const describe = (m) => `${m.Type}:${m.Name ?? m.Source}->${m.Destination}${m.RW ? '' : ':ro'}`;
    for (const c of [app, proxy]) {
      for (const m of c.Mounts ?? []) {
        if (/docker\.sock/.test(`${m.Source} ${m.Destination}`)) problems.push(`${c.Name}: mounts the Docker socket (${describe(m)})`);
      }
    }
    const appMounts = app.Mounts ?? [];
    if (appMounts.length !== 1 || appMounts[0].Type !== 'volume' || appMounts[0].Destination !== '/data') {
      problems.push(`app mounts ${appMounts.map(describe).join(', ') || 'nothing'}, expected only the data volume at /data`);
    }
    const proxyMounts = proxy.Mounts ?? [];
    let proxyConf;
    if (HUB) {
      // docker-compose.hub.yml: no mounts; the shell wrote HVWA_NGINX_CONF to the proxy's /tmp. It must be the
      // repo's nginx.conf byte for byte (this also proves compose's $$ unescaping produced the right config).
      if (proxyMounts.length !== 0) problems.push(`proxy mounts ${proxyMounts.map(describe).join(', ')}, expected none (nginx.conf is inline)`);
      const conf = exec('proxy', ['cat', '/tmp/nginx.conf']);
      const want = readFileSync(join(root, 'docker', 'proxy', 'nginx.conf'), 'utf8').replace(/\r\n/g, '\n').trim();
      if (conf.code !== 0) problems.push(`proxy: cat /tmp/nginx.conf: ${show(conf)}`);
      else if (conf.out.replace(/\r\n/g, '\n') !== want) problems.push('proxy: /tmp/nginx.conf differs from docker/proxy/nginx.conf');
      proxyConf = 'inline nginx.conf in /tmp (identical to docker/proxy/nginx.conf)';
    } else {
      if (proxyMounts.length !== 1 || proxyMounts[0].Type !== 'bind' || proxyMounts[0].Destination !== '/etc/nginx/nginx.conf' ||
        proxyMounts[0].RW !== false) {
        problems.push(`proxy mounts ${proxyMounts.map(describe).join(', ') || 'nothing'}, expected only nginx.conf read-only`);
      }
      proxyConf = proxyMounts[0] ? describe({ ...proxyMounts[0], Source: 'nginx.conf' }) : 'nothing';
    }
    // tmpfs: the only other writable paths; never executable.
    const tmpfs = (c, expected) => {
      const t = c.HostConfig.Tmpfs ?? {};
      if (Object.keys(t).sort().join(',') !== [...expected].sort().join(',')) {
        problems.push(`${c.Name}: tmpfs ${Object.keys(t).join(', ') || 'none'}, expected ${expected.join(', ')}`);
      }
      for (const [path, o] of Object.entries(t)) {
        for (const flag of ['noexec', 'nosuid', 'nodev']) if (!o.split(',').includes(flag)) problems.push(`${c.Name}: tmpfs ${path} lacks ${flag}`);
      }
    };
    tmpfs(app, ['/tmp']);
    tmpfs(proxy, ['/tmp', '/var/cache/nginx']);
    if (problems.length) throw new Error(problems.join('; '));
    return `app: ${describe(appMounts[0])} + tmpfs /tmp, init; proxy: ${proxyConf} + tmpfs; tmpfs all noexec,nosuid,nodev`;
  }],
  ['app is only on the internal lab network, whose gateway is isolated', () => {
    const lab = labNetwork();
    if (lab.Internal !== true) throw new Error(`app is on non-internal network ${lab.Name}`);
    // Without this, an internal bridge still gives the HOST an address (.1) on
    // the lab subnet, and the app can connect to the host's own services.
    const opts = lab.Options ?? {};
    if (opts['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated') {
      throw new Error(`${lab.Name}: com.docker.network.bridge.gateway_mode_ipv4 is ` +
        `${JSON.stringify(opts['com.docker.network.bridge.gateway_mode_ipv4'] ?? null)}, expected "isolated"`);
    }
    if (lab.EnableIPv6 && opts['com.docker.network.bridge.gateway_mode_ipv6'] !== 'isolated') {
      throw new Error(`${lab.Name}: IPv6 is enabled but gateway_mode_ipv6 is not "isolated"`);
    }
    return `${lab.Name}: internal, gateway_mode_ipv4=isolated`;
  }],
  ['NO route to the Docker host (no host address on lab; unused lab addresses silent; many ports)', () => {
    const lab = labNetwork();
    const held = new Map(Object.values(lab.Containers ?? {}).map((c) => [c.IPv4Address?.split('/')[0], c.Name]));
    const subnets = (lab.IPAM?.Config ?? []).filter((c) => c.Subnet && !c.Subnet.includes(':'));
    if (subnets.length === 0) throw new Error(`${lab.Name} has no IPv4 subnet to probe`);
    // 1. Where the host would sit on lab: the subnet's .1 and the IPAM gateway.
    //    With an isolated gateway there is no host address and Docker hands .1
    //    to a container; an address one of our containers holds is not the
    //    host, so it is reported instead of probed.
    const candidates = new Set();
    for (const c of subnets) {
      candidates.add(firstHost(c.Subnet));
      if (c.Gateway && !c.Gateway.includes(':')) candidates.add(c.Gateway);
    }
    const ours = [...candidates].filter((ip) => held.has(ip)).map((ip) => `${ip} is ${held.get(ip)}`);
    const groups = {
      'host candidates': [...candidates].filter((ip) => !held.has(ip)),
      // 2. Sanity: addresses on lab that nobody holds must not answer either.
      'unused lab addresses': subnets.flatMap((c) => unusedHosts(c.Subnet, held)),
      // 3. Off-link control: the host's address on edge. Expect ENETUNREACH (no route at all).
      'off-link control (edge gateway)': [],
    };
    const proxyNets = Object.keys(inspect('container', containerId('proxy')).NetworkSettings.Networks ?? {});
    for (const name of proxyNets.filter((n) => n !== lab.Name)) {
      for (const c of inspect('network', name).IPAM?.Config ?? []) {
        if (c.Gateway && !c.Gateway.includes(':')) groups['off-link control (edge gateway)'].push(c.Gateway);
      }
    }
    const ports = [9, 22, 53, 80, 443, 1337, 2375, 3000, 5432, 8080];
    const all = Object.values(groups).flat();
    if (all.length === 0) throw new Error('nothing to probe');
    const outcomes = tcpProbe(all.flatMap((ip) => ports.map((p) => [ip, p])));
    const reached = [];
    for (const [target, outcome] of Object.entries(outcomes)) {
      try { blockedOrThrow(target, outcome); } catch { reached.push(`${target} ${outcome}`); }
    }
    if (reached.length) throw new Error(`the app reaches the host: ${reached.join(', ')}`);
    const summary = (ips) => {
      const kinds = [...new Set(ips.flatMap((ip) => ports.map((p) => outcomes[`${ip}:${p}`])))].join('/');
      return `${ips.join(', ')} x ${ports.length} ports: ${kinds}`;
    };
    const parts = [];
    if (groups['host candidates'].length) parts.push(`host candidates ${summary(groups['host candidates'])}`);
    else {
      const isolated = lab.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] === 'isolated';
      parts.push(`no host address on lab (${isolated ? 'gateway isolated; ' : ''}${ours.join('; ')})`);
    }
    for (const label of ['unused lab addresses', 'off-link control (edge gateway)']) {
      if (groups[label].length) parts.push(`${label} ${summary(groups[label])}`);
    }
    return parts.join('; ');
  }],
  ['NO egress from the app (example.com, 1.1.1.1, the Docker host)', () => {
    // Positive control: the very same probe can reach the app itself.
    const self = exec('app', probe('http://127.0.0.1:1337/healthz'));
    if (self.code !== 0) throw new Error(`control probe to the app's own /healthz failed (${show(self)})`);
    return ['https://example.com', 'http://1.1.1.1', 'http://host.docker.internal:1337/']
      .map((u) => `${u} blocked (${expectBlocked(u)})`).join('; ');
  }],
  ['NO external DNS from the app (no DNS exfiltration channel)', () => {
    // c-ares straight at Docker's embedded resolver: exit 0 = resolved, 3 = refused/failed.
    const resolve = (name) => exec('app', ['node', '-e',
      `require('node:dns').promises.resolve4(${JSON.stringify(name)}).then((a)=>{console.log(a.join(','));process.exit(0)},` +
      '(e)=>{console.log(e.code);process.exit(3)})']);
    const internal = resolve('app');
    if (internal.code !== 0) throw new Error(`control: the internal name "app" does not resolve (${show(internal)})`);
    const external = resolve('example.com');
    if (external.code === 0) throw new Error(`example.com resolved from the app (${external.out}) — DNS is forwarded`);
    if (external.code !== 3) throw new Error(`DNS probe did not run (${show(external)})`);
    return `app -> ${internal.out}; example.com -> ${external.out}`;
  }],
  ['proxy is transparent: client headers, Host with port and a 20 MiB body reach the upstream unchanged', () =>
    withEchoUpstream(async () => {
      const problems = [];
      // Client-written forwarding headers are lab input (e.g. GK-03 trusts X-Real-IP): never rewritten.
      const sent = {
        'x-real-ip': '203.0.113.7',
        'x-forwarded-for': '198.51.100.1, 198.51.100.2',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'evil.example',
      };
      const a = JSON.parse((await getWithHost('/__echo?q=1', 'localhost:1337', sent)).body);
      if (a.headers.host !== 'localhost:1337') problems.push(`Host arrived as ${JSON.stringify(a.headers.host)}, sent "localhost:1337"`);
      for (const [k, v] of Object.entries(sent)) {
        if (a.headers[k] !== v) problems.push(`${k} arrived as ${JSON.stringify(a.headers[k])}, sent ${JSON.stringify(v)}`);
      }
      if (a.url !== '/__echo?q=1') problems.push(`URL arrived as ${a.url}`);
      // Nothing is added when the client sends none of them.
      const b = JSON.parse((await getWithHost('/__echo', '127.0.0.1:1337')).body);
      if (b.headers.host !== '127.0.0.1:1337') problems.push(`Host arrived as ${JSON.stringify(b.headers.host)}, sent "127.0.0.1:1337"`);
      for (const k of Object.keys(sent)) {
        if (k in b.headers) problems.push(`the proxy added ${k}: ${JSON.stringify(b.headers[k])}`);
      }
      // Upload labs: a body bigger than the proxy's 16 MiB tmpfs must stream through.
      const size = 20 * 2 ** 20;
      const up = await send('POST', '/__echo', 'localhost:1337', { 'content-type': 'application/octet-stream' }, Buffer.alloc(size, 0x61));
      if (up.status !== 200) problems.push(`20 MiB POST -> ${up.status}`);
      else if (JSON.parse(up.body).bytes !== size) problems.push(`20 MiB POST arrived as ${JSON.parse(up.body).bytes} bytes`);
      if (problems.length) throw new Error(problems.join('; '));
      return 'X-Real-IP, X-Forwarded-For/-Proto/-Host and Host:port unchanged, none added; 20 MiB POST streamed';
    })],
  ['data persists across `docker compose restart app`', async () => {
    dataFilesExist();
    const before = readSecret();
    const r = compose(['restart', 'app']);
    if (r.code !== 0) throw new Error(`docker compose restart app: ${show(r)}`);
    await waitHealthy('app', 60_000);
    dataFilesExist();
    if (readSecret() !== before) throw new Error('/data/flag-secret changed across the restart');
    await expect200('/healthz'); // the proxy finds the restarted app again
    return '/data/hvwa.db and /data/flag-secret survive; same secret; proxy reaches the restarted app';
  }],
];

/** True if something accepts connections on 127.0.0.1:port or the port can't be bound. */
async function portBusy(port) {
  const accepts = await new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    s.setTimeout(2000);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
  if (accepts) return true;
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(true));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(false)));
  });
}

/** Comparable form of a path (compose writes Windows paths with backslashes; drive-letter case varies). */
const samePath = (a, b) => {
  const norm = (p) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/**
 * The project name `hvwa` is shared by every checkout of the repo, so a stack
 * started from ANOTHER checkout (main repo, a git worktree...) looks like ours
 * to compose. Refuse to touch it: `up` would recreate it from this checkout's
 * files and `down` would remove it.
 */
function assertNoForeignStack() {
  const ps = run('docker', ['ps', '-a', '--filter', 'label=com.docker.compose.project=hvwa', '--format', '{{.ID}}']);
  if (ps.code !== 0) throw new Error(`docker ps: ${show(ps)}`);
  const ids = ps.out.split(/\r?\n/).filter(Boolean);
  for (const id of ids) {
    const c = inspect('container', id);
    const labels = c.Config?.Labels ?? {};
    const dir = labels['com.docker.compose.project.working_dir'] ?? '';
    const files = (labels['com.docker.compose.project.config_files'] ?? '').split(',').filter(Boolean);
    if (dir && samePath(dir, root)) continue;
    throw new Error(`BLOCKED: an HVWA stack from another checkout exists (container ${c.Name.replace(/^\//, '')}, ` +
      `${c.State?.Status ?? 'unknown state'}): ${files.join(', ') || dir || '(no compose labels)'}. Stop it from that ` +
      `checkout (docker compose -p hvwa down) and re-run. Nothing was changed.`);
  }
  return ids.length ? `${ids.length} existing HVWA container(s), all from this checkout` : 'no existing HVWA containers';
}

/** Host port 1337 must be free — or already held by this checkout's own proxy (a previous run). */
async function assertPortAvailable() {
  if (!(await portBusy(PORT))) return `host port ${PORT} is free`;
  const ours = compose(['port', 'proxy', '8080']);
  if (ours.code === 0 && ours.out === `127.0.0.1:${PORT}`) return `host port ${PORT} is held by this checkout's HVWA proxy (will be recreated)`;
  throw new Error(`BLOCKED: host port ${PORT} is in use by something that is not HVWA's compose project; ` +
    'refusing to start (nothing was changed)');
}

let started = false;

async function main() {
  say(assertNoForeignStack());
  say(await assertPortAvailable());
  started = true;
  // --force-recreate: every run starts from a known state. Without it, an
  // existing container whose config did not change is only re-attached to a
  // re-created network (e.g. after a driver option changed) and loses its
  // `app` alias, which makes the proxy answer 502.
  // The hub stack builds nothing: it runs the published image (a local one of that name wins, so a freshly
  // built sigmajo/hvwa:<tag> is checked before it is pushed).
  const build = HUB ? [] : ['--build'];
  say(`${HUB ? 'starting' : 'building and starting'}: docker compose -f ${COMPOSE_NAME} -p hvwa up -d ${build.join(' ')} --force-recreate --wait`);
  const up = compose(['up', '-d', ...build, '--force-recreate', '--wait', '--wait-timeout', '180'],
    { inherit: true, timeoutMs: 900_000 });
  if (up.code !== 0) {
    const ps = compose(['ps', '-a']);
    const logs = compose(['logs', '--no-color', '--tail', '60']);
    console.error([ps.out || ps.err, logs.out || logs.err].join('\n'));
    throw new Error(`docker compose up failed (exit ${up.code})`);
  }

  const failures = [];
  for (const [name, fn] of checks) {
    if (brokenStack) {
      failures.push(name);
      say(`SKIP ${name} — not run: ${brokenStack}`);
      continue;
    }
    try {
      const detail = await fn();
      say(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
    } catch (err) {
      failures.push(name);
      say(`FAIL ${name} — ${err.message}`);
    }
  }
  if (failures.length) {
    const logs = compose(['logs', '--no-color', '--tail', '40']);
    console.error(logs.out || logs.err);
    throw new Error(`${failures.length} of ${checks.length} check(s) failed or were skipped: ${failures.join('; ')}`);
  }
  return checks.length;
}

function down() {
  if (!started) return;
  started = false;
  say('stopping: docker compose -p hvwa down (data volume kept)');
  try {
    run('docker', ['rm', '-f', ECHO_NAME]); // a one-off from the transparency check, if interrupted
    const r = compose(['down'], { timeoutMs: 180_000 });
    if (r.code !== 0) say(`docker compose down: ${show(r)}`);
  } catch (err) {
    say(`docker compose down: ${err.message}`);
  }
}

// Ctrl+C / kill / closed terminal: still stop the stack. (A signal that
// arrives during a docker command is handled once that command returns.)
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(signal, () => {
    say(`${signal}: interrupted, cleaning up`);
    down();
    process.exit(code);
  });
}

main().then(
  (n) => { down(); say(`OK — all ${n} checks passed: the hardened container stack holds`); },
  (err) => { down(); console.error(`verify:docker FAILED: ${err.message}`); process.exitCode = 1; },
);
