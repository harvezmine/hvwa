// HVWA_ADMIN_PASSWORD at startup (src/server.ts, src/auth/startup.ts): it sets the FIRST password only, a set but
// ignored value is reported without its value, and the variable leaves process.env once the config holds it, so a
// lab that leaks the environment never sees it.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { adminPasswordNotice, scrubEnv } from '../src/auth/startup.js';
import { TEST_SECRET } from './helpers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'hvwa-startup-')); dirs.push(d); return d; };

describe('adminPasswordNotice (never sees the value: it takes only whether one was set)', () => {
  it('nothing to say when unset, or when it created the account', () => {
    expect(adminPasswordNotice(false, undefined)).toBeUndefined();
    expect(adminPasswordNotice(false, { accountCreated: false })).toBeUndefined();
    expect(adminPasswordNotice(true, { accountCreated: true })).toBeUndefined();
  });

  it('set but ignored: the account already exists, or the login is off', () => {
    expect(adminPasswordNotice(true, { accountCreated: false }))
      .toBe('HVWA: HVWA_ADMIN_PASSWORD is set but ignored: the admin account already exists (it only sets the first password; change it at /account/password)');
    expect(adminPasswordNotice(true, undefined)).toBe('HVWA: HVWA_ADMIN_PASSWORD is set but ignored: the login is off');
  });
});

describe('scrubEnv', () => {
  it('removes the named variables and nothing else', () => {
    const env: NodeJS.ProcessEnv = { HVWA_ADMIN_PASSWORD: 'x', PORT: '1337' };
    scrubEnv(env, ['HVWA_ADMIN_PASSWORD', 'NOT_THERE']);
    expect(env).toEqual({ PORT: '1337' });
    expect('HVWA_ADMIN_PASSWORD' in env).toBe(false);
  });
});

describe('AuthService.accountCreated', () => {
  it('is true for the start that created the account, false afterwards', () => {
    const dbPath = join(tempDir(), 'hvwa.db');
    const first = createApp({ flagSecret: TEST_SECRET, dbPath, auth: { initialPassword: 'First-Pass-123' } });
    const created = first.locals.auth?.accountCreated;
    first.locals.db.close(); // before any assertion: Windows cannot delete a file SQLite holds open
    const second = createApp({ flagSecret: TEST_SECRET, dbPath, auth: { initialPassword: 'Other-Pass-456' } });
    const again = second.locals.auth?.accountCreated;
    second.locals.db.close();
    expect(created).toBe(true);
    expect(again).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------- the real server
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
  });
}

// Loaded before src/server.ts: reports whether HVWA_ADMIN_PASSWORD is in process.env at preload time, then the
// moment it disappears (server.ts runs synchronously up to its first await, so an interval sees the result).
const PROBE = 'data:text/javascript,' + encodeURIComponent([
  "console.log('PROBE preload: ' + ('HVWA_ADMIN_PASSWORD' in process.env ? 'present' : 'absent'));",
  "const t = setInterval(() => { if (!('HVWA_ADMIN_PASSWORD' in process.env)) { console.log('PROBE: gone'); clearInterval(t); } }, 20);",
  't.unref();',
].join('\n'));

/** admin's sign-in status against a running server with this password: 303 = signed in, 401 = refused. */
async function signInStatus(port: number, password: string): Promise<number> {
  const base = `http://127.0.0.1:${port}`;
  const page = await fetch(`${base}/login`);
  const sid = /hvwa_sid=([^;]+)/.exec(page.headers.get('set-cookie') ?? '')?.[1] ?? '';
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? '';
  const res = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: `hvwa_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, username: 'admin', password }).toString(),
  });
  await res.arrayBuffer();
  return res.status;
}

/**
 * Start src/server.ts (tsx) like the image (NODE_ENV=production), wait for its banner, run `during` against it,
 * stop it; returns its output.
 */
async function startServer(dataDir: string, adminPassword: string, during: (port: number) => Promise<void>): Promise<string> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', PROBE, join(root, 'src', 'server.ts')], {
    cwd: root,
    env: {
      ...process.env, NODE_ENV: 'production', HVWA_AUTH: '', HVWA_EDITION: 'lite', HOST: '127.0.0.1', PORT: String(port),
      HVWA_DATA_DIR: dataDir, HVWA_ADMIN_PASSWORD: adminPassword, FLAG_SECRET: TEST_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.once('exit', r));
  try {
    const deadline = Date.now() + 45_000;
    while (!/HVWA: login on/.test(out) || !out.includes('PROBE: gone')) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`server did not start:\n${out}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 300)); // let a startup warning after the banner arrive
    await during(port);
    return out;
  } finally {
    child.kill();
    await exited;
  }
}

describe('src/server.ts with HVWA_ADMIN_PASSWORD (a real process)', () => {
  it('first start: uses it, no warning; later start: "set but ignored", the value never printed; gone from process.env', async () => {
    const dataDir = tempDir();
    const first = await startServer(dataDir, 'First-Pass-123', async (port) => {
      expect(await signInStatus(port, 'password')).toBe(401);
      expect(await signInStatus(port, 'First-Pass-123')).toBe(303);
    });
    expect(first).toContain('PROBE preload: present');
    expect(first).toContain('PROBE: gone');
    expect(first).not.toContain('set but ignored');
    expect(first).not.toContain('DEFAULT password'); // the configured first password is not the default
    const second = await startServer(dataDir, 'Other-Pass-456', async (port) => {
      expect(await signInStatus(port, 'Other-Pass-456')).toBe(401);
      expect(await signInStatus(port, 'First-Pass-123')).toBe(303);
    });
    expect(second).toContain('HVWA: HVWA_ADMIN_PASSWORD is set but ignored: the admin account already exists');
    expect(second).toContain('PROBE: gone');
    for (const out of [first, second]) {
      expect(out).not.toContain('First-Pass-123');
      expect(out).not.toContain('Other-Pass-456');
    }
  }, 120_000);
});
