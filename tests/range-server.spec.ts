// Portal mode from the environment (src/range/options.ts, src/server.ts): createApp's options, the range key persisted,
// and a real `src/server.ts` process with HVWA_MODE=portal against a real warden (stub Engine): it reconciles at start,
// serves the portal behind the login, and removes every secret from its environment.
// Compact POC (plan amendment): limits are { capacity, idleMs, maxMs, startTimeoutMs } and registration is open unless
// HVWA_REGISTRATION_OPEN=0; there is no Extend/ceiling and no event code.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/config.js';
import { loadRangeConfig } from '../src/range/config.js';
import { portalAppOptions } from '../src/range/options.js';
import { createDockerClient } from '../src/warden/docker.js';
import { createWarden } from '../src/warden/warden.js';
import { createWardenServer } from '../src/warden/server.js';
import { parseRegistry } from '../src/lab-registry.js';
import { startDockerStub, type DockerStub } from './support/docker-stub.js';
import { labEntry } from './support/range.js';
import { serve, TEST_SECRET } from './helpers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const W = 'w'.repeat(40);
const F = 'f'.repeat(40);
const ADMIN = 'Admin-Pass-1234';
const dirs: string[] = [];
const stubs: DockerStub[] = [];
afterEach(async () => {
  for (const s of stubs.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'hvwa-portal-')); dirs.push(d); return d; };
function registryFile(dir: string): string {
  const file = join(dir, 'registry.json');
  writeFileSync(file, JSON.stringify({ schema: 1, labs: [labEntry('r01', 'clinic')] }));
  return file;
}
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => resolve(port)); });
});

describe('portalAppOptions', () => {
  it('portal mode behind the tunnel: https, Secure host-only cookies, 10-character passwords, the range from the environment', () => {
    const dir = temp();
    const r = loadRangeConfig({
      HVWA_RANGE_DOMAIN: 'hvwa.my.id', HVWA_ADMIN_PASSWORD: ADMIN, HVWA_WARDEN_SECRET: W, HVWA_FORWARD_AUTH_SECRET: F,
      HVWA_LAB_REGISTRY: registryFile(dir), HVWA_RANGE_CAPACITY: '3',
    });
    if (!r.ok) throw new Error(r.errors.join('\n'));
    const opts = portalAppOptions(parseConfig({ HVWA_ADMIN_PASSWORD: ADMIN, HVWA_MODE: 'portal', FLAG_SECRET: TEST_SECRET }), r.config, dir);
    expect(opts).toMatchObject({
      mode: 'portal', dbPath: join(dir, 'hvwa.db'),
      // The POC's 40-50 concurrent players plus health checks: 60 new sessions a minute is too low.
      maxNewSessionsPerMinute: 600,
      auth: { initialPassword: ADMIN, secureCookies: true, publicScheme: 'https', passwordMinLength: 10 },
      range: {
        domain: 'hvwa.my.id', portalHost: 'hvwa.my.id', internalHost: 'portal', forwardAuthSecret: F, publicScheme: 'https', secureCookies: true,
        registrationOpen: true,
        limits: { capacity: 3, idleMs: 20 * 60_000, maxMs: 60 * 60_000, startTimeoutMs: 90_000 },
      },
    });
    expect(opts.range?.registry.get('r01')?.app).toBe('App clinic');
    expect(readFileSync(join(dir, 'range-key'), 'utf8').trim()).toBe(opts.range?.rangeKey);
  });

  it('a local run (HVWA_RANGE_PUBLIC_SCHEME=http): no Secure attribute anywhere, the Origin check expects http', () => {
    const dir = temp();
    const r = loadRangeConfig({
      HVWA_RANGE_DOMAIN: 'localhost', HVWA_PORTAL_HOST: 'hvwa.localhost', HVWA_RANGE_PUBLIC_SCHEME: 'http', HVWA_RANGE_PUBLIC_PORT: '18080',
      HVWA_ADMIN_PASSWORD: ADMIN, HVWA_WARDEN_SECRET: W, HVWA_FORWARD_AUTH_SECRET: F, HVWA_LAB_REGISTRY: registryFile(dir),
    });
    if (!r.ok) throw new Error(r.errors.join('\n'));
    const opts = portalAppOptions(parseConfig({ HVWA_ADMIN_PASSWORD: ADMIN, HVWA_MODE: 'portal', FLAG_SECRET: TEST_SECRET }), r.config, dir);
    expect(opts).toMatchObject({
      auth: { secureCookies: false, publicScheme: 'http' },
      range: { portalHost: 'hvwa.localhost', publicScheme: 'http', publicPort: 18080, secureCookies: false },
    });
  });
});

describe('src/server.ts with HVWA_MODE=portal (a real process)', () => {
  const PROBE = 'data:text/javascript,' + encodeURIComponent([
    "const names = ['HVWA_ADMIN_PASSWORD', 'HVWA_WARDEN_SECRET', 'HVWA_FORWARD_AUTH_SECRET'];",
    "console.log('PROBE preload: ' + names.filter((n) => n in process.env).length + ' present');",
    "const t = setInterval(() => { if (names.every((n) => !(n in process.env))) { console.log('PROBE: gone'); clearInterval(t); } }, 20);",
    't.unref();',
  ].join('\n'));

  function start(env: Record<string, string>) {
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', PROBE, join(root, 'src', 'server.ts')], {
      cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    return { child, exited, output: () => out };
  }

  it('reconciles with the warden, serves the portal behind the login, and scrubs the secrets', async () => {
    const stub = await startDockerStub();
    stubs.push(stub);
    stub.addContainer('hvwa-range-traefik');
    const registry = parseRegistry({ schema: 1, labs: [labEntry('r01', 'clinic')] });
    const warden = createWarden({ docker: createDockerClient(stub.url), registry, settings: { domain: 'range.test', runtime: 'runc', traefikContainer: 'hvwa-range-traefik' } });
    const wardenPort = (serve(createWardenServer({ warden, secret: W })).address() as AddressInfo).port;
    const dir = temp();
    const port = await freePort();
    const p = start({
      HVWA_MODE: 'portal', HOST: '127.0.0.1', PORT: String(port), HVWA_DATA_DIR: dir, FLAG_SECRET: TEST_SECRET,
      HVWA_RANGE_DOMAIN: 'range.test', HVWA_ADMIN_PASSWORD: ADMIN, HVWA_WARDEN_URL: `http://127.0.0.1:${wardenPort}`,
      HVWA_WARDEN_SECRET: W, HVWA_FORWARD_AUTH_SECRET: F, HVWA_LAB_REGISTRY: registryFile(dir),
    });
    try {
      const deadline = Date.now() + 45_000;
      while (!/HVWA: mode portal/.test(p.output()) || !p.output().includes('PROBE: gone')) {
        if (Date.now() > deadline || p.child.exitCode !== null) throw new Error(`portal did not start:\n${p.output()}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(p.output()).toContain('PROBE preload: 3 present');
      const base = `http://127.0.0.1:${port}`;
      expect((await fetch(`${base}/`, { redirect: 'manual' })).status).toBe(303);
      const page = await fetch(`${base}/login`);
      const sid = /hvwa_sid=([^;]+)/.exec(page.headers.get('set-cookie') ?? '')?.[1] ?? '';
      const csrf = /name="_csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? '';
      const login = await fetch(`${base}/login`, {
        method: 'POST', redirect: 'manual', headers: { cookie: `hvwa_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrf, username: 'admin', password: ADMIN }).toString(),
      });
      expect(login.status).toBe(303);
      const auth = /hvwa_auth=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
      expect(login.headers.get('set-cookie')).toMatch(/; Secure/);
      const home = await fetch(`${base}/`, { headers: { cookie: `hvwa_sid=${sid}; hvwa_auth=${auth}` } });
      expect(home.status).toBe(200);
      expect(await home.text()).toContain('data-lab="r01"');
      await new Promise((r) => setTimeout(r, 300));
      expect(stub.calls.some((c) => c.path.startsWith('/v1.44/containers/json'))).toBe(true); // reconcile listed the range's containers
      expect(p.output()).not.toContain(W);
      expect(p.output()).not.toContain(ADMIN);
    } finally {
      p.child.kill();
      await p.exited;
    }
  }, 120_000);

  it('refuses to start with an incomplete portal configuration: exit 1, one line per problem, no value', async () => {
    const p = start({ HVWA_MODE: 'portal', HOST: '127.0.0.1', PORT: String(await freePort()), HVWA_DATA_DIR: temp(), HVWA_WARDEN_SECRET: 'Tiny-Secret-Value' });
    expect(await p.exited).toBe(1);
    expect(p.output()).toContain('HVWA: invalid range configuration (HVWA_MODE=portal):');
    expect(p.output()).toContain('HVWA_RANGE_DOMAIN: is required in portal mode');
    expect(p.output()).toContain('HVWA_WARDEN_SECRET: must be at least 32 characters');
    expect(p.output()).not.toContain('Tiny-Secret-Value');
  }, 60_000);
});
