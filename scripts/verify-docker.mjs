// scripts/verify-docker.mjs — `npm run verify:docker` (NOT part of `npm test`;
// needs a running Docker engine). Builds and starts the hardened compose stack,
// then checks from the outside that the isolation really holds: HTTP through
// the loopback-only proxy, a non-root app on a read-only rootfs, NO egress from
// the app, data surviving a restart. Ends with `docker compose down` (the data
// volume is kept). Exit code 0 = every check passed.
import { spawnSync } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 1337;
const BASE = `http://127.0.0.1:${PORT}`;
// Every compose call names the file AND the project explicitly, so `down`,
// `restart` etc. can only ever touch HVWA's own containers/networks — never
// another compose project on this machine.
const COMPOSE = ['compose', '-f', join(root, 'docker-compose.yml'), '-p', 'hvwa'];
const say = (msg) => console.log(`verify:docker ${msg}`);

// The persisted-secret path (/data/flag-secret) is part of what is checked, so
// a FLAG_SECRET from the developer's .env or shell must not apply to this run
// (shell env beats .env in compose interpolation; blank means "unset").
const env = { ...process.env, FLAG_SECRET: '' };

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

async function get(path) {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
  return { status: res.status, body: await res.text() };
}
async function expect200(path) {
  const r = await get(path);
  if (r.status !== 200) throw new Error(`GET ${path} -> ${r.status}`);
  return r.body;
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

function expectBlocked(url) {
  const r = exec('app', probe(url));
  if (r.code === 0) throw new Error(`the app reached ${url} — egress is NOT blocked`);
  if (r.code !== 3) throw new Error(`egress probe for ${url} did not run (${show(r)})`);
  return r.out || 'network error';
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
  ['GET / -> 200 and every linked /c/<id> challenge page -> 200', async () => {
    const index = await expect200('/');
    const ids = [...new Set([...index.matchAll(/href="\/c\/([A-Z]{2}-\d{2})"/g)].map((m) => m[1]))];
    if (ids.length === 0) throw new Error('the portal index links no /c/<id> challenge');
    for (const id of ids) {
      const page = await expect200(`/c/${id}`);
      if (!page.includes(id)) throw new Error(`/c/${id} does not mention ${id}`);
    }
    // Runtime assets: the --omit=dev image must still carry htmx.org (a prod dependency).
    for (const asset of ['/static/app.css', '/static/vendor/htmx.min.js']) await expect200(asset);
    return `${ids.length} challenge page(s): ${ids.join(', ')}; static assets served`;
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
  ['hardening flags on every container', () =>
    ['app', 'proxy'].map((s) => `${s}: ${checkHostConfig(s)}`).join(' | ')],
  ['app is attached only to internal networks', () => {
    const nets = Object.keys(inspect('container', containerId('app')).NetworkSettings.Networks ?? {});
    if (nets.length === 0) throw new Error('app has no network');
    for (const n of nets) {
      if (inspect('network', n).Internal !== true) throw new Error(`app is on non-internal network ${n}`);
    }
    return nets.join(', ');
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

/** Host port 1337 must be free — or already held by HVWA's own proxy (a previous run). */
async function assertPortAvailable() {
  if (!(await portBusy(PORT))) return `host port ${PORT} is free`;
  const ours = compose(['port', 'proxy', '8080']);
  if (ours.code === 0 && ours.out === `127.0.0.1:${PORT}`) return `host port ${PORT} is held by HVWA's own proxy (will be recreated)`;
  throw new Error(`BLOCKED: host port ${PORT} is in use by something that is not HVWA's compose project; ` +
    'refusing to start (nothing was changed)');
}

let started = false;

async function main() {
  say(await assertPortAvailable());
  started = true;
  say('building and starting: docker compose -p hvwa up -d --build --wait');
  const up = compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180'], { inherit: true, timeoutMs: 900_000 });
  if (up.code !== 0) throw new Error(`docker compose up failed (exit ${up.code})`);

  const failures = [];
  for (const [name, fn] of checks) {
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
    throw new Error(`${failures.length} check(s) failed: ${failures.join('; ')}`);
  }
}

function down() {
  if (!started) return;
  say('stopping: docker compose -p hvwa down (data volume kept)');
  try {
    const r = compose(['down'], { timeoutMs: 180_000 });
    if (r.code !== 0) say(`docker compose down: ${show(r)}`);
  } catch (err) {
    say(`docker compose down: ${err.message}`);
  }
}

main().then(
  () => { down(); say('OK — the hardened container stack holds'); },
  (err) => { down(); console.error(`verify:docker FAILED: ${err.message}`); process.exitCode = 1; },
);
