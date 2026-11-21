// The portal's warden client (src/range/warden-client.ts) against the REAL warden server (src/warden/server.ts) on the
// stub Engine: the contract both sides share (src/warden/protocol.ts), the bearer secret, and the error codes.
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createDockerClient } from '../src/warden/docker.js';
import { createWarden } from '../src/warden/warden.js';
import { createWardenServer } from '../src/warden/server.js';
import { createWardenClient } from '../src/range/warden-client.js';
import { WardenError } from '../src/warden/protocol.js';
import { startDockerStub, type DockerStub } from './support/docker-stub.js';
import { testRegistry } from './support/range.js';
import { serve } from './helpers.js';

const SECRET = 'w'.repeat(40);
const ID = 'abcdefghijklmnopqrstuvwxyz';
const FLAG = 'HVWA{abcdefghijklmnopqrstuvwxyz}'; // 26 base32 characters (RANGE_FLAG_RE)
const stubs: DockerStub[] = [];
afterEach(async () => { for (const s of stubs.splice(0)) await s.close(); });
const urlOf = (app: express.Express) => `http://127.0.0.1:${(serve(app).address() as AddressInfo).port}`;

async function wardenUrl() {
  const stub = await startDockerStub();
  stubs.push(stub);
  const registry = testRegistry();
  for (const lab of registry.labs) stub.images.set(lab.image, { healthcheck: true });
  stub.addContainer('hvwa-range-traefik');
  const warden = createWarden({ docker: createDockerClient(stub.url), registry, settings: { domain: 'range.test', runtime: 'runc', traefikContainer: 'hvwa-range-traefik' } });
  return { stub, url: urlOf(createWardenServer({ warden, secret: SECRET })) };
}

describe('createWardenClient', () => {
  it('launch, list, health, stop through the real server', async () => {
    const { stub, url } = await wardenUrl();
    const client = createWardenClient({ baseUrl: url, secret: SECRET });
    await client.launch({ labId: 'r01', level: 'acolyte', instanceId: ID, flag: FLAG, userId: 4, expiresAt: 1_800_000_000_000 });
    expect(stub.container(`hvwa-i-${ID}`)?.status).toBe('running');
    expect(await client.list()).toEqual([{ instanceId: ID, labId: 'r01', level: 'acolyte', userId: 4, expiresAt: 1_800_000_000_000, state: 'running' }]);
    expect(await client.health(ID)).toEqual({ status: 'starting' });
    stub.setHealth(`hvwa-i-${ID}`, 'healthy');
    expect(await client.health(ID)).toEqual({ status: 'ready' });
    await client.stop(ID);
    expect(await client.health(ID)).toEqual({ status: 'missing' });
  });

  it('maps failures to WardenError codes: unauthorized, unknown_lab, unavailable (down or a malformed answer)', async () => {
    const { url } = await wardenUrl();
    const wrong = createWardenClient({ baseUrl: url, secret: 'x'.repeat(40) });
    await expect(wrong.list()).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    const client = createWardenClient({ baseUrl: url, secret: SECRET });
    await expect(client.launch({ labId: 'r09', level: 'acolyte', instanceId: ID, flag: FLAG, userId: 4, expiresAt: 1 }))
      .rejects.toMatchObject({ code: 'unknown_lab', status: 404 });
    const nowhere = createWardenClient({ baseUrl: 'http://127.0.0.1:9', secret: SECRET, timeoutMs: 1000 });
    await expect(nowhere.list()).rejects.toBeInstanceOf(WardenError);
    await expect(nowhere.list()).rejects.toMatchObject({ code: 'unavailable' });
    const junk = express();
    junk.get('/v1/instances', (_req, res) => { res.json({ instances: 'not a list' }); });
    junk.get('/v1/instances/:id/health', (_req, res) => { res.json({ status: 'fine' }); });
    const bad = createWardenClient({ baseUrl: urlOf(junk), secret: SECRET });
    await expect(bad.list()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(bad.health(ID)).rejects.toMatchObject({ code: 'unavailable' });
  });
});
