import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { listen, closeGracefully, listenUrl, startupBanner } from '../src/lifecycle.js';

function occupyPort(): Promise<{ blocker: Server; port: number }> {
  return new Promise((resolve) => {
    const blocker = createServer();
    blocker.listen(0, '127.0.0.1', () => resolve({ blocker, port: (blocker.address() as AddressInfo).port }));
  });
}

describe('listen()', () => {
  it('resolves with a listening server on a free port', async () => {
    const app = createApp();
    const server = await listen(app, 0, '127.0.0.1');
    try {
      expect(server.listening).toBe(true);
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(await res.json()).toEqual({ status: 'ok' });
    } finally {
      await closeGracefully(server, app.locals.db);
    }
  });

  it('rejects (instead of crashing) when the port is in use', async () => {
    const { blocker, port } = await occupyPort();
    try {
      await expect(listen(createApp(), port, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      blocker.close();
    }
  });
});

describe('closeGracefully()', () => {
  it('closes the DB only after server.close() has completed', async () => {
    const app = createApp();
    const server = await listen(app, 0, '127.0.0.1');
    const order: string[] = [];
    const realClose = server.close.bind(server);
    server.close = ((cb?: (err?: Error) => void) => realClose((err) => {
      order.push('server closed');
      cb?.(err);
    })) as typeof server.close;
    const db = app.locals.db;
    const realDbClose = db.close.bind(db);
    db.close = () => { order.push('db closed'); realDbClose(); };

    await closeGracefully(server, db);
    expect(order).toEqual(['server closed', 'db closed']);
    expect(server.listening).toBe(false);
    expect(db.isOpen).toBe(false);
  });

  it('closes an idle keep-alive socket right away instead of waiting for the timeout', async () => {
    const app = createApp();
    const server = await listen(app, 0, '127.0.0.1');
    const { port } = server.address() as AddressInfo;
    await fetch(`http://127.0.0.1:${port}/healthz`); // leaves an idle keep-alive socket
    const started = Date.now();
    await closeGracefully(server, app.locals.db, 2000);
    expect(Date.now() - started).toBeLessThan(2000); // idle sockets are closed, not waited out
    expect(app.locals.db.isOpen).toBe(false);
  });
});

describe('listenUrl()', () => {
  it.each([
    ['127.0.0.1', 1337, 'http://127.0.0.1:1337'],
    ['localhost', 8080, 'http://localhost:8080'],
    ['::1', 1337, 'http://[::1]:1337'],
    ['::', 80, 'http://[::]:80'],
    ['[::1]', 1337, 'http://[::1]:1337'],
  ])('%s:%i → %s', (host, port, url) => {
    expect(listenUrl(host, port)).toBe(url);
  });
});

describe('startupBanner()', () => {
  it('states the URL with the safety warning, then the registered challenge count (read by verify:dist)', () => {
    expect(startupBanner('http://127.0.0.1:1337', 18)).toEqual([
      'HVWA on http://127.0.0.1:1337 — DO NOT expose to untrusted networks',
      'HVWA: 18 challenge(s) registered',
    ]);
    expect(startupBanner('http://[::1]:80', 0)[1]).toBe('HVWA: 0 challenge(s) registered');
  });

  it('names the edition after the count when given (the count is the edition\'s)', () => {
    expect(startupBanner('http://127.0.0.1:1337', 5, { edition: 'lite' })).toEqual([
      'HVWA on http://127.0.0.1:1337 — DO NOT expose to untrusted networks',
      'HVWA: 5 challenge(s) registered',
      'HVWA: edition lite',
    ]);
  });
});

describe('server.ts', () => {
  it('prints the startup banner with the count of the challenges it serves (its edition)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/const served = app\.locals\.challenges\.all\(\)\.length;/);
    expect(src).toMatch(/startupBanner\(listenUrl\(config\.HOST, config\.PORT\), served, \{ edition: app\.locals\.edition/);
  });
});
