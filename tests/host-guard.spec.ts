import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { once } from 'node:events';
import { connect, type AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { createApp, type HvwaApp } from '../src/app.js';
import { hostnameOf, LOOPBACK_HOSTNAMES } from '../src/core/host-guard.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Send a raw request (so Host can be omitted or empty) and return the status + body. */
async function raw(app: HvwaApp, head: string): Promise<{ status: number; body: string }> {
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
    return { status, body: text.slice(text.indexOf('\r\n\r\n') + 4) };
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

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

  it('server.ts passes HVWA_ALLOWED_HOSTS to createApp()', () => {
    const src = readFileSync(join(root, 'src', 'server.ts'), 'utf8');
    expect(src).toMatch(/allowedHosts:\s*config\.HVWA_ALLOWED_HOSTS/);
  });
});
