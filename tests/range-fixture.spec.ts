// The fixture lab (labs/_fixture: NOT a catalog lab; scripts/range-verify.mjs launches it), run here as a plain Node
// process: it plants HVWA_FLAG as a file and as a page, removes it from its environment, answers its health path; its
// manifest parses and its Dockerfile follows the range lab runtime contract.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { labManifestSchema } from '../src/lab-registry.js';

const dir = join(process.cwd(), 'labs', '_fixture');
const FLAG = 'HVWA{abcdefghijklmnopqrstuvwx}';
const kids: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) k.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => resolve(port)); });
});

async function run(level: string, flag?: string) {
  const port = await freePort();
  const data = mkdtempSync(join(tmpdir(), 'hvwa-fixture-'));
  dirs.push(data);
  const flagFile = join(data, 'hvwa', 'flag.txt');
  const env: NodeJS.ProcessEnv = { ...process.env, HVWA_LEVEL: level, HVWA_PORT: String(port), HVWA_INSTANCE_HOST: 'i-x.localhost', HVWA_FIXTURE_FLAG_FILE: flagFile };
  delete env.HVWA_FLAG;
  if (flag !== undefined) env.HVWA_FLAG = flag;
  const child = spawn(process.execPath, [join(dir, 'app', 'server.mjs')], { env, stdio: 'ignore' });
  kids.push(child);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error('the fixture did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  return { base, port, flagFile };
}
const health = (port: number) => spawnSync(process.execPath, [join(dir, 'app', 'health.mjs')], { env: { ...process.env, HVWA_PORT: String(port) }, timeout: 10_000 }).status;

describe('labs/_fixture/app', () => {
  it('Templar: the flag is a file and a page, gone from the environment; health passes', async () => {
    const { base, port, flagFile } = await run('templar', FLAG);
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: 'ok' });
    expect(await (await fetch(`${base}/`)).text()).toContain('data-testid="level">templar<');
    expect(await (await fetch(`${base}/flag`)).text()).toContain(FLAG);
    expect(readFileSync(flagFile, 'utf8').trim()).toBe(FLAG);
    expect(await (await fetch(`${base}/env`)).json()).toMatchObject({ flagInEnv: false });
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect(health(port)).toBe(0);
    expect(health(await freePort())).toBe(1);
  });

  it('Divine: a decoy that explains it is the secure reference; no flag anywhere', async () => {
    const { base, flagFile } = await run('divine');
    const page = await (await fetch(`${base}/flag`)).text();
    expect(page).toContain('Divine is the secure reference');
    expect(page).not.toMatch(/HVWA\{/);
    expect(readFileSync(flagFile, 'utf8')).not.toMatch(/HVWA\{/);
  });

  it('/headers echoes the request headers (range-verify proves Traefik strips the forward-auth secret)', async () => {
    const { base } = await run('acolyte', FLAG);
    expect(await (await fetch(`${base}/headers`, { headers: { 'x-probe': 'yes' } })).json()).toMatchObject({ 'x-probe': 'yes' });
  });
});

describe('labs/_fixture manifest and image', () => {
  it('lab.json is a valid manifest: r00, port 8080, /healthz, the flag as a file, one small /tmp', () => {
    const m = labManifestSchema.parse(JSON.parse(readFileSync(join(dir, 'lab.json'), 'utf8')));
    expect(m).toMatchObject({ id: 'r00', slug: 'fixture', port: 8080, health: '/healthz', flag: { placement: 'file:/tmp/hvwa/flag.txt' },
      tmpfs: [{ path: '/tmp', sizeMiB: 16 }], levels: ['acolyte', 'templar', 'inquisitor', 'divine'] });
  });

  it('the Dockerfile: pinned base, setuid/setgid stripped, no package managers, uid 10001, a HEALTHCHECK, node only', () => {
    const lines = readFileSync(join(dir, 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n').split('\n');
    expect(lines).toContain('FROM node:22.23.5-alpine3.24');
    expect(lines).toContain('USER 10001:10001');
    expect(lines).toContain('HEALTHCHECK --interval=2s --timeout=2s --start-period=30s --start-interval=500ms --retries=3 CMD ["node", "/app/health.mjs"]');
    expect(lines).toContain('CMD ["node", "/app/server.mjs"]');
    expect(lines.join('\n')).toMatch(/-perm \/6000 -exec chmod a-s/);
    expect(lines.join('\n')).toMatch(/\/usr\/local\/bin\/npm/);
    expect(lines.join('\n')).not.toMatch(/^(ADD|RUN (apk|npm) (add|install))/m);
  });
});
