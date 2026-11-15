import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { once } from 'node:events';
import { connect, type AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { appOptionsFromConfig, createApp, type HvwaApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { hostnameOf, targetHostname, LOOPBACK_HOSTNAMES } from '../src/core/host-guard.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });

/** Send a raw request (so Host can be omitted, empty, duplicated...) and return status, raw head and body. */
async function raw(app: HvwaApp, head: string): Promise<{ status: number; head: string; body: string }> {
  const server: Server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as AddressInfo;
    const socket = connect(port, '127.0.0.1');
    socket.end(`${head}\r\n\r\n`);
    let text = '';
    socket.setEncoding('utf8').on('data', (d: string) => { text += d; });
    await once(socket, 'close');
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1]);
    const split = text.indexOf('\r\n\r\n');
    return { status, head: text.slice(0, split), body: text.slice(split + 4) };
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
const close = 'Connection: close';

describe('hostnameOf (Host header -> lowercase hostname, port dropped)', () => {
  it.each([
    ['localhost', 'localhost'],
    ['localhost:1337', 'localhost'],
    ['LocalHost:80', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
    ['127.0.0.1:1337', '127.0.0.1'],
    ['[::1]', '[::1]'],
    ['[::1]:1337', '[::1]'],
    ['localhost.:1337', 'localhost'], // FQDN root dot, as nginx's $host does
    ['Evil.Example:8080', 'evil.example'],
  ])('%j -> %j', (header, hostname) => {
    expect(hostnameOf(header)).toBe(hostname);
  });

  it.each([undefined, '', '   ', ':1337', 'localhost:', 'localhost:abc', 'localhost:1337:1', 'localhost:99999',
    '::1', '[::1', '[::1]x', '[::1]:', 'local host', 'localhost/x', 'user@localhost'])(
    'malformed %j -> undefined', (header) => {
      expect(hostnameOf(header)).toBeUndefined();
    });

  it('the loopback allowlist is exactly localhost, 127.0.0.1 and [::1]', () => {
    expect([...LOOPBACK_HOSTNAMES].sort()).toEqual(['127.0.0.1', '[::1]', 'localhost']);
  });
});

describe('Host allowlist middleware (DNS-rebinding guard)', () => {
  it.each(['localhost', 'localhost:1337', '127.0.0.1:1337', '[::1]:1337', '[::1]', 'LocalHost:8080', 'LOCALHOST'])(
    'allows Host %j', async (host) => {
      const res = await request(createApp()).get('/healthz').set('Host', host);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

  it('allows supertest\'s default Host (127.0.0.1:<port>)', async () => {
    expect((await request(createApp()).get('/healthz')).status).toBe(200);
  });

  it.each(['evil.example', 'evil.example:1337', '127.0.0.1.evil.example', 'localhost.evil.example',
    'localhost.evil.example:1337', '127.0.0.2', '0.0.0.0:1337', 'hvwa.lab'])(
    'rejects Host %j with 421 plain text, before any route', async (host) => {
      const app = createApp();
      for (const path of ['/healthz', '/', '/static/app.css', '/api/submit', '/no-such-page']) {
        const res = await request(app).get(path).set('Host', host);
        expect(res.status, path).toBe(421);
        expect(res.headers['content-type'], path).toMatch(/^text\/plain/);
        expect(res.text, path).toMatch(/^421 Misdirected Request/);
        expect(res.text, path).not.toContain(host); // never reflected
        expect(res.text, path).not.toMatch(/<html/i);
      }
      const post = await request(app).post('/api/submit').set('Host', host).send({ flag: 'x' });
      expect(post.status).toBe(421);
    });

  it('rejects a request with no Host header (HTTP/1.0)', async () => {
    const r = await raw(createApp(), 'GET /healthz HTTP/1.0');
    expect(r.status).toBe(421);
    expect(r.body).toMatch(/^421 Misdirected Request/);
  });

  it('rejects an empty Host header', async () => {
    const r = await raw(createApp(), 'GET /healthz HTTP/1.1\r\nHost: \r\nConnection: close');
    expect(r.status).toBe(421);
  });

  it.each([false, true])('X-Forwarded-Host never affects the decision (trust proxy %s)', async (trust) => {
    const app = createApp();
    app.set('trust proxy', trust);
    const ok = await request(app).get('/healthz').set('Host', 'localhost:1337').set('X-Forwarded-Host', 'evil.example');
    expect(ok.status).toBe(200);
    const bad = await request(app).get('/healthz').set('Host', 'evil.example').set('X-Forwarded-Host', 'localhost');
    expect(bad.status).toBe(421);
  });

  it('allowedHosts adds exact extra hostnames (case-insensitive, any port, no wildcards)', async () => {
    const app = createApp({ allowedHosts: ['hvwa.lab'] });
    for (const host of ['hvwa.lab', 'HVWA.LAB:1337', 'localhost:1337']) {
      expect((await request(app).get('/healthz').set('Host', host)).status, host).toBe(200);
    }
    for (const host of ['sub.hvwa.lab', 'hvwa.lab.evil.example', 'evil.example']) {
      expect((await request(app).get('/healthz').set('Host', host)).status, host).toBe(421);
    }
  });

  it('rejected requests never reach the session middleware (no Set-Cookie); allowed ones do', async () => {
    const app = createApp();
    const ok = await request(app).get('/').set('Host', 'localhost:1337');
    expect(String(ok.headers['set-cookie'])).toMatch(/hvwa_sid=/); // positive control
    const bad = await request(app).get('/').set('Host', 'evil.example');
    expect(bad.status).toBe(421);
    expect(bad.headers['set-cookie']).toBeUndefined();
    const dup = await raw(app, `GET / HTTP/1.1\r\nHost: localhost\r\nHost: evil.example\r\n${close}`);
    expect(dup.status).toBe(400);
    expect(dup.head).not.toMatch(/^set-cookie:/im);
  });
});

describe('duplicate Host headers', () => {
  it.each([
    ['allowed first', 'localhost:1337', 'evil.example'],
    ['allowed second', 'evil.example', 'localhost:1337'],
    ['both allowed', 'localhost', '127.0.0.1'],
  ])('more than one Host (%s) -> 400 that echoes neither value', async (_case, first, second) => {
    const r = await raw(createApp(), `GET /healthz HTTP/1.1\r\nHost: ${first}\r\nHost: ${second}\r\n${close}`);
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/^400 Bad Request/);
    expect(r.body).not.toContain(first);
    expect(r.body).not.toContain(second);
    expect(r.head).toMatch(/^content-type: text\/plain/im);
  });

  it('case variants count as the same header', async () => {
    const r = await raw(createApp(), `GET /healthz HTTP/1.1\r\nhost: localhost\r\nHOST: evil.example\r\n${close}`);
    expect(r.status).toBe(400);
  });
});

describe('absolute-form request targets', () => {
  // origin-form and '*' -> null (no authority); malformed or non-http(s) -> undefined
  it.each([
    ['/healthz', null],
    ['*', null],
    ['http://localhost/healthz', 'localhost'],
    ['http://localhost:1337/healthz', 'localhost'],
    ['HTTP://LOCALHOST/healthz', 'localhost'],
    ['https://[::1]:1337/x?y=1', '[::1]'],
    ['http://evil.example/healthz', 'evil.example'],
    ['http://localhost@evil.example/', undefined], // userinfo
    ['ftp://localhost/', undefined],
    ['http:///healthz', undefined],
    ['healthz', undefined],
  ])('targetHostname(%j) -> %j', (url, expected) => {
    expect(targetHostname(url)).toBe(expected);
  });

  it.each([
    ['http://evil.example/healthz', 'localhost:1337'],
    ['http://127.0.0.1.evil.example:1337/healthz', '127.0.0.1:1337'],
    ['http://localhost:1337/healthz', 'evil.example'], // Host is still checked
    ['http://localhost@evil.example/healthz', 'localhost'],
  ])('GET %s with Host %s -> 421', async (target, host) => {
    const r = await raw(createApp(), `GET ${target} HTTP/1.1\r\nHost: ${host}\r\n${close}`);
    expect(r.status).toBe(421);
    expect(r.body).toMatch(/^421 Misdirected Request/);
    expect(r.body).not.toContain('evil.example');
  });

  it('an absolute-form target naming an allowed host passes', async () => {
    const r = await raw(createApp(), `GET http://localhost:1337/healthz HTTP/1.1\r\nHost: localhost:1337\r\n${close}`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ status: 'ok' });
  });

  it('the asterisk form is checked on Host only', async () => {
    const ok = await raw(createApp(), `OPTIONS * HTTP/1.1\r\nHost: localhost\r\n${close}`);
    expect([400, 421]).not.toContain(ok.status);
    const bad = await raw(createApp(), `OPTIONS * HTTP/1.1\r\nHost: evil.example\r\n${close}`);
    expect(bad.status).toBe(421);
  });
});

describe('appOptionsFromConfig (what server.ts passes to createApp)', () => {
  const SECRET16 = '0123456789abcdef';

  it('maps the data dir, flag secret and HVWA_ALLOWED_HOSTS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hvwa-opts-'));
    dirs.push(dir);
    const opts = appOptionsFromConfig(parseConfig({ FLAG_SECRET: SECRET16, HVWA_ALLOWED_HOSTS: 'hvwa.lab' }), dir);
    expect(opts).toEqual({ dbPath: join(dir, 'hvwa.db'), flagSecret: SECRET16, allowedHosts: ['hvwa.lab'] });
  });

  it('without FLAG_SECRET, uses the secret persisted in the data dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hvwa-opts-'));
    dirs.push(dir);
    const opts = appOptionsFromConfig(parseConfig({}), dir);
    expect(opts.flagSecret).toBe(readFileSync(join(dir, 'flag-secret'), 'utf8').trim());
    expect(opts.allowedHosts).toEqual([]);
  });

  it('an app built from it answers to HVWA_ALLOWED_HOSTS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hvwa-opts-'));
    dirs.push(dir);
    const app = createApp(appOptionsFromConfig(parseConfig({ FLAG_SECRET: SECRET16, HVWA_ALLOWED_HOSTS: 'hvwa.lab' }), dir));
    try {
      expect((await request(app).get('/healthz').set('Host', 'hvwa.lab:1337')).status).toBe(200);
      expect((await request(app).get('/healthz').set('Host', 'evil.example')).status).toBe(421);
    } finally {
      app.locals.db.close(); // Windows cannot delete a file SQLite holds open
    }
  });
});
