// scripts/range-verify.mjs — `npm run range:verify` (NOT part of `npm test`; needs Docker Engine 28+, the docker CLI and
// a free loopback port 18080). Builds the range images (scripts/range-images.mjs build) and the fixture lab, then runs
// its OWN copy of docker-compose.range.yml in local mode: project hvwa-range-verify, its own external network
// hvwa-range-verify-edge (HVWA_EDGE_NETWORK) with a TCP forwarder on 127.0.0.1:18080 standing in for cloudflared, plain
// HTTP, the portal at hvwa.localhost, instances at i-<id>.localhost, capacity 2, runtime HVWA_VERIFY_RUNTIME (runc;
// runsc on a host with gVisor). Then it checks spec §11 from the outside:
//   container hardening exact; Traefik publishes nothing and listens only toward the tunnel; the gate and forward-auth;
//   host-only cookies; cross-user refusal; instance -> internet / DNS / portal / warden / socket proxies / another
//   instance / Traefik all blocked; the client IP (CF-Connecting-IP) behind the registration limit; a flag shared between
//   users refused; the proxies' allowlists; a full range refusing a launch (the compact POC has no queue); the reaper
//   (a crashed instance); the startup reconcile (an orphan); Stop.
// Stops at the first failure (later checks build on earlier ones), prints the stack's logs, and always ends with
// `docker compose down -v` plus the removal of its forwarder, its edge network and every hvwa-i-* it made.
// Refuses to start, changing nothing, when an hvwa.range=1 container or an hvwa-i-* network already exists on this
// engine: a real range's reaper and this one would fight over them.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './main-module.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT = 'hvwa-range-verify';
const COMPOSE_FILE = join(root, 'docker-compose.range.yml');
const COMPOSE = ['compose', '-f', COMPOSE_FILE, '-p', PROJECT];
const EDGE_NETWORK = `${PROJECT}-edge`;
const TUNNEL = `${PROJECT}-tunnel`;
const TRAEFIK = `${PROJECT}-traefik`;
const HTTP_PORT = Number(process.env.HVWA_VERIFY_HTTP_PORT || 18080);
const RUNTIME = (process.env.HVWA_VERIFY_RUNTIME || 'runc').trim();
const PORTAL = 'hvwa.localhost';
const FIXTURE_TAG = 'hvwa-lab/r00:verify';
const PASSWORD = 'Verify-Pass-1234';
const say = (msg) => console.log(`range:verify ${msg}`);

/** What src/warden/template.ts creates for the fixture (no lower limits, one 16 MiB /tmp), as Docker reports it. */
export function expectedHostConfig(runtime = 'runc') {
  return Object.freeze({
    ReadonlyRootfs: true, CapDrop: ['ALL'], Privileged: false, PidsLimit: 128, Memory: 268435456, MemorySwap: 268435456,
    NanoCpus: 500000000, PublishAllPorts: false, IpcMode: 'private', Runtime: runtime, SecurityOpt: ['no-new-privileges:true'],
    RestartPolicy: { Name: 'no', MaximumRetryCount: 0 }, Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=16m' },
  });
}

/** Every way an instance (`docker container inspect`) and its network (`docker network inspect`) differ from spec §7. */
export function hardeningProblems(container, network, instanceId, traefikName, runtime = 'runc') {
  const p = [];
  const hc = container.HostConfig ?? {};
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const [k, v] of Object.entries(expectedHostConfig(runtime))) {
    if (!same(hc[k], v)) p.push(`HostConfig.${k} is ${JSON.stringify(hc[k])}, want ${JSON.stringify(v)}`);
  }
  const empty = (x) => x === null || x === undefined || (Array.isArray(x) ? x.length === 0 : typeof x === 'object' && Object.keys(x).length === 0);
  for (const k of ['CapAdd', 'Binds', 'Mounts', 'Devices', 'VolumesFrom', 'PortBindings']) if (!empty(hc[k])) p.push(`HostConfig.${k} is not empty: ${JSON.stringify(hc[k])}`);
  if ((hc.SecurityOpt ?? []).some((o) => /unconfined/.test(o))) p.push('a security profile is unconfined');
  if (hc.NetworkMode !== `hvwa-i-${instanceId}`) p.push(`HostConfig.NetworkMode is ${hc.NetworkMode}`);
  if (!empty(container.Mounts)) p.push(`Mounts: ${JSON.stringify(container.Mounts)}`);
  const user = String(container.Config?.User ?? '');
  if (!/^\d+:\d+$/.test(user) || Number(user.split(':')[0]) < 1000) p.push(`User is "${user}", want a uid of 1000 or more`);
  if (container.Config?.Labels?.['hvwa.range'] !== '1') p.push('the label hvwa.range=1 is missing');
  if (network.Internal !== true) p.push('the instance network is not internal');
  if (network.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated') p.push('the instance network gateway is not isolated');
  const members = Object.values(network.Containers ?? {}).map((c) => c.Name).sort();
  const want = [`hvwa-i-${instanceId}`, traefikName].sort();
  if (!same(members, want)) p.push(`the instance network holds ${members.join(', ')}; want ${want.join(', ')}`);
  return p;
}

/** blocked = nothing answered; refused = a host said no (nothing listens); anything else = reached. */
export function classifyProbe(outcome) {
  if (['ETIMEDOUT', 'TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'EAI_FAIL', 'EAI_NONAME'].includes(outcome)) return 'blocked';
  if (outcome === 'ECONNREFUSED') return 'refused';
  return 'reached';
}

// ------------------------------------------------------------------------------------------------ process helpers
/** Enough for compose to parse the file (its `:?` variables) before the real values exist: the preflight's `down`. */
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
const inspect = (kind, name) => JSON.parse(must('docker', [kind, 'inspect', name]))[0];
const exists = (kind, name) => run('docker', [kind, 'inspect', name]).code === 0;
const serviceContainer = (service) => `${PROJECT}-${service}-1`;
/** A container's address on a network: the exact name (external and instance networks) or the compose-prefixed one. */
function ipOn(container, network) {
  const nets = inspect('container', container).NetworkSettings.Networks;
  const key = Object.keys(nets).find((n) => n === network || n === `${PROJECT}_${network}`);
  if (!key) throw new Error(`${container} is not on ${network}`);
  return nets[key].IPAddress;
}
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
function browser(headers = {}) {
  const jar = newJar();
  return {
    jar,
    get: (host, path) => hit('GET', host, path, { jar, headers }),
    form: (host, path, fields, extra = {}) => hit('POST', host, path, {
      jar, headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded', ...extra }, body: new URLSearchParams(fields).toString(),
    }),
  };
}
function csrfOf(html) {
  const v = /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
  if (!v) throw new Error('no _csrf field on the page');
  return v;
}

// ------------------------------------------------- probes from INSIDE an instance (docker exec from the host CLI)
const TCP_PROBE = (host, port) => `const s=require('node:net').connect({host:${JSON.stringify(host)},port:${port}});`
  + "s.setTimeout(4000,()=>{console.log('TIMEOUT');process.exit(0)});s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});"
  + "s.on('error',(e)=>{console.log(e.code||e.message);process.exit(0)})";
function probe(container, host, port) {
  const r = run('docker', ['exec', container, 'node', '-e', TCP_PROBE(host, port)], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`the probe in ${container} did not run: ${show(r)}`);
  return classifyProbe(r.out.trim());
}
function dnsProbe(container, name) {
  const script = `require('node:dns').lookup(${JSON.stringify(name)},(e)=>{console.log(e?e.code:'RESOLVED')})`;
  return must('docker', ['exec', container, 'node', '-e', script], { timeoutMs: 30_000 });
}

// ------------------------------------------------------------------------------------------------ the flows
const s = { launchMs: [] };
const secrets = {};

async function register(username, b = browser()) {
  const page = await b.get(PORTAL, '/register');
  if (page.status !== 200) throw new Error(`GET /register -> ${page.status}`);
  const r = await b.form(PORTAL, '/register', { _csrf: csrfOf(page.body), username, password: PASSWORD, confirm: PASSWORD });
  return { b, r };
}
async function player(username) {
  const { b, r } = await register(username);
  if (r.status !== 303 || r.headers.location !== '/login?registered=1') throw new Error(`register ${username} -> ${r.status} ${r.headers.location ?? ''}`);
  const login = await b.get(PORTAL, '/login');
  const signed = await b.form(PORTAL, '/login', { _csrf: csrfOf(login.body), username, password: PASSWORD });
  if (signed.status !== 303) throw new Error(`sign-in of ${username} -> ${signed.status}`);
  const auth = signed.setCookies.find((l) => l.startsWith('hvwa_auth=')) ?? '';
  if (!/; HttpOnly/i.test(auth) || /domain=/i.test(auth)) throw new Error(`hvwa_auth is not host-only HttpOnly: ${auth}`);
  return b;
}
const panel = async (b, level) => (await b.get(PORTAL, `/labs/r00/panel?level=${level}`)).body;
async function action(b, name, level) {
  const page = await b.get(PORTAL, `/labs/r00?level=${level}`);
  return b.form(PORTAL, `/labs/r00/${name}`, { _csrf: csrfOf(page.body), level });
}
async function launch(b, level) {
  const t0 = Date.now();
  const r = await action(b, 'launch', level);
  if (r.status !== 303) throw new Error(`launch -> ${r.status}`);
  await poll(`the ${level} instance to run`, async () => /data-state="running"/.test(await panel(b, level)), 60_000);
  return Date.now() - t0;
}
async function open(b) {
  const page = await b.get(PORTAL, '/labs/r00');
  const r = await b.form(PORTAL, '/labs/r00/open', { _csrf: csrfOf(page.body) });
  if (r.status !== 303) throw new Error(`open -> ${r.status}`);
  const u = new URL(r.headers.location);
  if (u.protocol !== 'http:' || Number(u.port) !== HTTP_PORT || !/^i-[a-z2-7]{26}\.localhost$/.test(u.hostname)) throw new Error(`Open lab -> ${u.href}`);
  return { id: u.hostname.slice(2, -'.localhost'.length), host: u.hostname, gatePath: `${u.pathname}${u.search}` };
}
function randomInstanceId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return [...randomBytes(26)].map((b) => alphabet[b & 31]).join('');
}

const checks = [
  ['the portal answers through the tunnel stand-in; Traefik publishes no port', async () => {
    const h = await hit('GET', PORTAL, '/healthz');
    if (h.status !== 200 || JSON.parse(h.body).status !== 'ok') throw new Error(`GET /healthz -> ${h.status}`);
    const t = inspect('container', TRAEFIK);
    if (Object.keys(t.HostConfig.PortBindings ?? {}).length > 0) throw new Error(`Traefik publishes ${JSON.stringify(t.HostConfig.PortBindings)}`);
  }],
  ['three players register and sign in; hvwa_auth is host-only', async () => {
    s.alice = await player('alice_v');
    s.bob = await player('bob_v');
    s.carol = await player('carol_v');
  }],
  ['the registration limit keys on CF-Connecting-IP (5 per hour per client IP)', async () => {
    const from = (ip) => browser({ 'cf-connecting-ip': ip });
    for (let i = 1; i <= 5; i++) {
      const { r } = await register(`cf_a${i}`, from('203.0.113.9'));
      if (r.status !== 303) throw new Error(`registration ${i} from 203.0.113.9 -> ${r.status}`);
    }
    const sixth = (await register('cf_a6', from('203.0.113.9'))).r;
    if (sixth.status !== 429) throw new Error(`the 6th registration from one IP -> ${sixth.status}`);
    const other = (await register('cf_b1', from('198.51.100.4'))).r;
    if (other.status !== 303) throw new Error(`a registration from another IP -> ${other.status}`);
  }],
  ['alice launches the fixture at Templar; it becomes ready', async () => {
    s.launchMs.push(await launch(s.alice, 'templar'));
    s.a = await open(s.alice);
    return `ready in ${s.launchMs[0]} ms (instance ${s.a.id}, runtime ${RUNTIME})`;
  }],
  ['the instance container and its network are exactly spec §7', () => {
    const p = hardeningProblems(inspect('container', `hvwa-i-${s.a.id}`), inspect('network', `hvwa-i-${s.a.id}`), s.a.id, TRAEFIK, RUNTIME);
    if (p.length) throw new Error(p.join('; '));
  }],
  ['Open lab: the single-use ticket becomes a host-only hvwa_gate cookie; the lab answers; a replay is refused', async () => {
    const r = await s.alice.get(s.a.host, s.a.gatePath);
    if (r.status !== 303 || r.headers.location !== '/') throw new Error(`gate -> ${r.status} ${r.headers.location ?? ''}`);
    const line = r.setCookies.find((l) => l.startsWith('hvwa_gate=')) ?? '';
    for (const part of [/; HttpOnly/i, /; SameSite=Lax/i, /; Path=\//]) if (!part.test(line)) throw new Error(`hvwa_gate lacks ${part}: ${line}`);
    if (/domain=/i.test(line)) throw new Error('hvwa_gate has a Domain attribute');
    if (/; Secure/i.test(line)) throw new Error('hvwa_gate is Secure on a plain-http local run (the public scheme is http)');
    if (r.setCookies.some((l) => /^hvwa_(sid|auth)=/.test(l))) throw new Error('a portal cookie was set on the lab host');
    const home = await s.alice.get(s.a.host, '/');
    if (home.status !== 200 || !home.body.includes('data-testid="level">templar<')) throw new Error(`the lab -> ${home.status}`);
    if (/hvwa_(sid|auth)=/.test(JSON.parse((await s.alice.get(s.a.host, '/headers')).body).cookie ?? '')) throw new Error('portal cookies reached the lab');
    const replay = await browser().get(s.a.host, s.a.gatePath);
    if (replay.status !== 401) throw new Error(`a replayed ticket -> ${replay.status}`);
  }],
  ['the lab never sees the forward-auth secret', async () => {
    const h = JSON.parse((await s.alice.get(s.a.host, '/headers')).body);
    if ('x-hvwa-auth-secret' in h || JSON.stringify(h).includes(secrets.forward)) throw new Error('the forward-auth secret reached the lab');
  }],
  ["cross-user: no cookie, a forged cookie, and bob's own cookie on alice's host are 401", async () => {
    s.launchMs.push(await launch(s.bob, 'acolyte'));
    s.b = await open(s.bob);
    await s.bob.get(s.b.host, s.b.gatePath);
    const bobs = s.bob.jar.get(s.b.host, 'hvwa_gate');
    if (!bobs) throw new Error('bob got no gate cookie');
    const tries = [
      ['no cookie', await browser().get(s.a.host, '/')],
      ['a forged cookie', await hit('GET', s.a.host, '/', { headers: { cookie: `hvwa_gate=v1.${s.a.id}.1.9999999999999.${'A'.repeat(43)}` } })],
      ["bob's cookie", await hit('GET', s.a.host, '/', { headers: { cookie: `hvwa_gate=${bobs}` } })],
    ];
    for (const [what, r] of tries) {
      if (r.status !== 401) throw new Error(`${what} -> ${r.status}`);
      if (!r.body.includes(`http://${PORTAL}:${HTTP_PORT}/`)) throw new Error(`${what}: the 401 page does not link the portal`);
    }
  }],
  ["from inside alice's instance: no internet, no DNS, no portal, no warden, no proxy, no other instance, nothing from Traefik", () => {
    const c = `hvwa-i-${s.a.id}`;
    const targets = [
      ['the internet (1.1.1.1:443)', '1.1.1.1', 443],
      ['the internet (8.8.8.8:53)', '8.8.8.8', 53],
      ['the portal (edge)', ipOn(serviceContainer('portal'), 'edge'), 1337],
      ['the portal (control)', ipOn(serviceContainer('portal'), 'control'), 1337],
      ['the warden', ipOn(serviceContainer('warden'), 'control'), 8080],
      ['the write socket proxy', ipOn(serviceContainer('socket-proxy'), 'control'), 2375],
      ['the read-only socket proxy', ipOn(serviceContainer('socket-proxy-ro'), 'traefik-ro'), 2375],
      ["bob's instance", ipOn(`hvwa-i-${s.b.id}`, `hvwa-i-${s.b.id}`), 8080],
      ["Traefik's tunnel-side address", ipOn(TRAEFIK, EDGE_NETWORK), 80],
      ["Traefik's edge address", ipOn(TRAEFIK, 'edge'), 80],
      ['the tunnel stand-in', ipOn(TUNNEL, EDGE_NETWORK), 8080],
    ];
    const reached = targets.map(([what, host, port]) => [what, probe(c, host, port)]).filter(([, o]) => o !== 'blocked');
    if (reached.length) throw new Error(reached.map(([w, o]) => `${w}: ${o}`).join('; '));
    const dns = dnsProbe(c, 'example.com');
    if (dns === 'RESOLVED') throw new Error('the instance resolved example.com');
    const traefikHere = ipOn(TRAEFIK, `hvwa-i-${s.a.id}`);
    for (const port of [80, 8082]) {
      const o = probe(c, traefikHere, port);
      if (o === 'reached') throw new Error(`Traefik answers the instance on ${traefikHere}:${port} (it could reach the portal and forge CF-Connecting-IP)`);
    }
    return `${targets.length} targets blocked, DNS ${dns}, Traefik listens on nothing toward instances`;
  }],
  ["the flag: a file and a page, gone from the environment, uid 10001; bob cannot score alice's flag; alice can", async () => {
    const flag = /<pre data-testid="flag">(HVWA\{[a-z2-7]{26}\})<\/pre>/.exec((await s.alice.get(s.a.host, '/flag')).body)?.[1];
    if (!flag) throw new Error('no flag on /flag');
    const info = JSON.parse((await s.alice.get(s.a.host, '/env')).body);
    if (info.flagInEnv !== false || info.uid !== 10001) throw new Error(`/env says ${JSON.stringify(info)}`);
    if (must('docker', ['exec', `hvwa-i-${s.a.id}`, 'cat', '/tmp/hvwa/flag.txt']) !== flag) throw new Error('the flag file differs');
    const submit = async (b, f) => {
      const page = await b.get(PORTAL, '/labs/r00');
      return (await b.form(PORTAL, '/labs/r00/submit', { _csrf: csrfOf(page.body), submission: f }, { 'hx-request': 'true' })).body;
    };
    if (!(await submit(s.bob, flag)).includes('data-result="wrong"')) throw new Error("bob scored alice's flag");
    if (!(await submit(s.alice, flag)).includes('data-result="new_best"')) throw new Error('alice could not score her own flag');
  }],
  ['the socket proxies: only containers and networks; the read-only one refuses writes', () => {
    const w = serviceContainer('warden');
    const status = (path, method) => Number(must('docker', ['exec', w, 'node', '-e',
      `fetch('http://socket-proxy:2375${path}',{method:'${method}'}).then(r=>console.log(r.status),()=>console.log(0))`]));
    const table = [['/v1.44/containers/json', 'GET', 200], ['/v1.44/networks', 'GET', 200], ['/v1.44/images/json', 'GET', 403],
      ['/v1.44/volumes', 'GET', 403], ['/v1.44/info', 'GET', 403], ['/v1.44/swarm', 'GET', 403], ['/v1.44/exec/x/start', 'POST', 403],
      ['/v1.44/build', 'POST', 403]];
    const wrong = table.map(([p, m, want]) => [p, m, want, status(p, m)]).filter(([, , want, got]) => got !== want);
    if (wrong.length) throw new Error(wrong.map(([p, m, want, got]) => `${m} ${p}: ${got}, want ${want}`).join('; '));
    const post = run('docker', ['exec', TRAEFIK, 'wget', '-q', '-O', '-', '--post-data=', 'http://socket-proxy-ro:2375/v1.44/containers/create']);
    if (post.code === 0 || !/403/.test(post.err)) throw new Error(`the read-only proxy accepted a POST (${show(post)})`);
    const read = run('docker', ['exec', TRAEFIK, 'wget', '-q', '-O', '/dev/null', 'http://socket-proxy-ro:2375/v1.44/containers/json']);
    if (read.code !== 0) throw new Error(`the read-only proxy refused a read (${show(read)})`);
  }],
  ['a full range (capacity 2) refuses carol with the range-full panel; after bob stops she starts; bob leaves nothing behind', async () => {
    const refused = await action(s.carol, 'launch', 'acolyte');
    if (refused.status !== 303 || !/[?&]r=full(?:&|$)/.test(refused.headers.location ?? '')) {
      throw new Error(`a launch at capacity -> ${refused.status} ${refused.headers.location ?? ''}`);
    }
    const page = await s.carol.get(PORTAL, refused.headers.location);
    if (page.status !== 200 || !page.body.includes('data-testid="range-full"')) throw new Error('the range-full panel did not show');
    if (!page.body.includes('The range is full. Try again in a minute.')) throw new Error('the range-full panel has the wrong text');
    if (/data-state="(?:running|starting)"/.test(await panel(s.carol, 'acolyte'))) throw new Error('carol got an instance at capacity');
    await action(s.bob, 'stop', 'acolyte');
    s.launchMs.push(await launch(s.carol, 'acolyte'));
    s.c = await open(s.carol);
    if (exists('container', `hvwa-i-${s.b.id}`) || exists('network', `hvwa-i-${s.b.id}`)) throw new Error("bob's container or network is still there");
  }],
  ['the reaper reports a crashed instance as failed (crashed)', async () => {
    must('docker', ['kill', `hvwa-i-${s.c.id}`]);
    await poll("carol's panel to show the crash", async () => /data-reason="crashed"/.test(await panel(s.carol, 'acolyte')), 90_000, 2000);
  }],
  ['the portal removes an orphan container when it starts (reconcile)', async () => {
    const id = randomInstanceId();
    must('docker', ['run', '-d', '--name', `hvwa-i-${id}`, '--label', 'hvwa.range=1', '--label', `hvwa.instance=${id}`,
      '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', FIXTURE_TAG]);
    const r = compose(['restart', 'portal'], { timeoutMs: 180_000 });
    if (r.code !== 0) throw new Error(`restart portal: ${show(r)}`);
    await poll('the orphan to be removed', async () => !exists('container', `hvwa-i-${id}`), 90_000, 1000);
  }],
  ["Stop removes alice's container, its network and Traefik's endpoint; the host stops answering", async () => {
    await action(s.alice, 'stop', 'templar');
    await poll("alice's container to go", async () => !exists('container', `hvwa-i-${s.a.id}`), 30_000);
    if (exists('network', `hvwa-i-${s.a.id}`)) throw new Error("alice's network is still there");
    if (Object.keys(inspect('container', TRAEFIK).NetworkSettings.Networks).includes(`hvwa-i-${s.a.id}`)) throw new Error('Traefik is still attached');
    const after = await hit('GET', s.a.host, '/', { headers: { cookie: `hvwa_gate=${s.alice.jar.get(s.a.host, 'hvwa_gate')}` } });
    if (after.status === 200) throw new Error('the stopped lab still answers');
  }],
];

// ------------------------------------------------------------------------------------------------ run
let tmp = '';
let started = false;

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
  if (!(await portFree(HTTP_PORT))) throw new Error(`BLOCKED: 127.0.0.1:${HTTP_PORT} is in use (set HVWA_VERIFY_HTTP_PORT)`);
}

async function main() {
  await preflight();
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  say(`building the range images (${version}) and the fixture lab`);
  env = { ...process.env, ...PARSE_ENV, HVWA_RANGE_VERSION: version };
  must(process.execPath, [join(root, 'scripts', 'range-images.mjs'), 'build'], { inherit: true, timeoutMs: 1_800_000 });
  must('docker', ['build', '-t', FIXTURE_TAG, join(root, 'labs', '_fixture')], { inherit: true, timeoutMs: 900_000 });
  const fixtureId = must('docker', ['image', 'inspect', '--format', '{{.Id}}', FIXTURE_TAG]);
  tmp = mkdtempSync(join(tmpdir(), 'hvwa-range-verify-'));
  const registry = join(tmp, 'registry.json');
  const lab = JSON.parse(readFileSync(join(root, 'labs', '_fixture', 'lab.json'), 'utf8'));
  writeFileSync(registry, JSON.stringify({ schema: 1, labs: [{ ...lab, version: '0.0.0', image: fixtureId }] }));
  secrets.admin = randomBytes(12).toString('base64url');
  secrets.warden = randomBytes(32).toString('hex');
  secrets.forward = randomBytes(32).toString('hex');
  // Local mode (PARSE_ENV already names the edge network, the Traefik container and HVWA_RANGE_DOMAIN=localhost).
  env = {
    ...process.env, ...PARSE_ENV, HVWA_RANGE_VERSION: version,
    HVWA_PORTAL_HOST: PORTAL, HVWA_RANGE_PUBLIC_SCHEME: 'http', HVWA_RANGE_PUBLIC_PORT: String(HTTP_PORT),
    HVWA_ADMIN_PASSWORD: secrets.admin, HVWA_WARDEN_SECRET: secrets.warden, HVWA_FORWARD_AUTH_SECRET: secrets.forward,
    HVWA_RANGE_KEY: '', HVWA_RANGE_CAPACITY: '2', HVWA_REGISTRATION_OPEN: '1', HVWA_LAB_REGISTRY_FILE: registry,
    HVWA_RANGE_RUNTIME: RUNTIME,
  };
  started = true;
  must('docker', ['network', 'create', EDGE_NETWORK]); // stands in for the owner's hvwa-edge
  say(`starting: docker compose -f docker-compose.range.yml -p ${PROJECT} up -d --wait`);
  const up = compose(['up', '-d', '--wait', '--wait-timeout', '240'], { inherit: true, timeoutMs: 900_000 });
  if (up.code !== 0) throw new Error(`docker compose up failed (exit ${up.code})`);
  // The tunnel stand-in: what cloudflared does on the server (a plain TCP hop to traefik:80), on loopback only.
  const forwarder = "const n=require('node:net');n.createServer((c)=>{const u=n.connect(80,'traefik');c.pipe(u).pipe(c);"
    + "c.on('error',()=>u.destroy());u.on('error',()=>c.destroy())}).listen(8080)";
  must('docker', ['run', '-d', '--name', TUNNEL, '--network', EDGE_NETWORK, '-p', `127.0.0.1:${HTTP_PORT}:8080`, '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', `sigmajo/hvwa:range-portal-${version}`, 'node', '-e', forwarder]);
  await poll('the portal through the tunnel stand-in', async () => (await hit('GET', PORTAL, '/healthz')).status === 200, 60_000);

  for (const [name, fn] of checks) {
    try {
      const detail = await fn();
      say(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
    } catch (err) {
      say(`FAIL ${name} — ${err.message}`);
      const logs = compose(['logs', '--no-color', '--tail', '60']);
      console.error(logs.out || logs.err);
      throw new Error(`stopped at: ${name}`);
    }
  }
  say(`launch to ready: ${s.launchMs.join(' ms, ')} ms`);
  return checks.length;
}

function cleanup() {
  if (!started && !tmp) return;
  say(`stopping: the forwarder, docker compose -p ${PROJECT} down -v, the edge network, and every hvwa-i-* this run made`);
  try {
    removeOwnLeftovers();
    const left = run('docker', ['ps', '-aq', '--filter', 'label=hvwa.range=1']).out.split(/\s+/).filter(Boolean);
    if (left.length) run('docker', ['rm', '-f', ...left]);
    const nets = run('docker', ['network', 'ls', '-q', '--filter', 'name=hvwa-i-']).out.split(/\s+/).filter(Boolean);
    if (nets.length) run('docker', ['network', 'rm', ...nets]);
    run('docker', ['network', 'rm', EDGE_NETWORK]); // again: it is free only once every hvwa-i-* endpoint is gone
    run('docker', ['image', 'rm', FIXTURE_TAG]);
  } catch (err) {
    say(`cleanup: ${err.message}`);
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
    (n) => { cleanup(); say(`OK — all ${n} checks passed: the range holds (spec §11)`); },
    (err) => { cleanup(); console.error(`range:verify FAILED: ${err.message}`); process.exitCode = 1; },
  );
}
