// The warden's HTTP API (src/warden/server.ts) and environment (src/warden/config.ts): a bearer shared secret on every
// /v1 route (constant-time), strict small bodies, error codes the portal understands; the secret is never echoed.
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createDockerClient } from '../src/warden/docker.js';
import { createWarden } from '../src/warden/warden.js';
import { createWardenServer } from '../src/warden/server.js';
import { loadWardenConfig } from '../src/warden/config.js';
import { startDockerStub, type DockerStub } from './support/docker-stub.js';
import { testRegistry } from './support/range.js';

const SECRET = 's'.repeat(40);
const ID = 'abcdefghijklmnopqrstuvwxyz';
const FLAG = 'HVWA{abcdefghijklmnopqrstuvwxyz}'; // 26 base32 characters (RANGE_FLAG_RE)
const stubs: DockerStub[] = [];
afterEach(async () => { for (const s of stubs.splice(0)) await s.close(); });

async function setup() {
  const stub = await startDockerStub();
  stubs.push(stub);
  const registry = testRegistry();
  for (const lab of registry.labs) stub.images.set(lab.image, { healthcheck: true });
  stub.addContainer('hvwa-range-traefik');
  const warden = createWarden({ docker: createDockerClient(stub.url), registry, settings: { domain: 'hvwa.my.id', runtime: 'runc', traefikContainer: 'hvwa-range-traefik' } });
  return { stub, app: createWardenServer({ warden, secret: SECRET }) };
}
const auth = { authorization: `Bearer ${SECRET}` };
const body = { labId: 'r01', level: 'acolyte', instanceId: ID, flag: FLAG, userId: 3, expiresAt: 1_800_000_000_000 };

describe('createWardenServer', () => {
  it('/healthz is open; every /v1 route needs the exact bearer secret (401 otherwise, same body)', async () => {
    const { app } = await setup();
    expect((await request(app).get('/healthz')).body).toEqual({ status: 'ok' });
    for (const headers of [{}, { authorization: SECRET }, { authorization: `Bearer ${SECRET}x` }, { authorization: 'Bearer ' }, { authorization: `bearer ${SECRET}` }]) {
      const res = await request(app).get('/v1/instances').set(headers);
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    }
    expect((await request(app).post('/v1/instances').send(body)).status).toBe(401);
  });

  it('launch -> 201, list, health, stop -> 204; the container exists in between', async () => {
    const { app, stub } = await setup();
    const launched = await request(app).post('/v1/instances').set(auth).send(body);
    expect(launched.status).toBe(201);
    expect(launched.body).toEqual({ instanceId: ID });
    expect(stub.container(`hvwa-i-${ID}`)?.status).toBe('running');
    expect((await request(app).get('/v1/instances').set(auth)).body.instances).toHaveLength(1);
    expect((await request(app).get(`/v1/instances/${ID}/health`).set(auth)).body).toEqual({ status: 'starting' });
    expect((await request(app).delete(`/v1/instances/${ID}`).set(auth)).status).toBe(204);
    expect(stub.container(`hvwa-i-${ID}`)).toBeUndefined();
  });

  it('refuses extra keys and unknown labs with the closed error codes; a big body is 413; nothing is created', async () => {
    const { app, stub } = await setup();
    const extra = await request(app).post('/v1/instances').set(auth).send({ ...body, HostConfig: { Privileged: true } });
    expect([extra.status, extra.body]).toEqual([400, { error: 'bad_request' }]);
    const unknown = await request(app).post('/v1/instances').set(auth).send({ ...body, labId: 'r77' });
    expect([unknown.status, unknown.body]).toEqual([404, { error: 'unknown_lab' }]);
    expect((await request(app).post('/v1/instances').set(auth).send({ ...body, pad: 'x'.repeat(5000) })).status).toBe(413);
    expect((await request(app).delete('/v1/instances/..%2F..%2Fetc').set(auth)).status).toBe(400);
    expect((await request(app).get('/v1/nope').set(auth)).status).toBe(404);
    expect(stub.containers().map((c) => c.name)).toEqual(['hvwa-range-traefik']);
  });

  it('the caller never reaches the container configuration: any key but the six ids, a prototype key, odd bodies are 400', async () => {
    const { app, stub } = await setup();
    const raw = JSON.stringify(body).slice(0, -1);
    const json = [
      JSON.stringify({ ...body, Privileged: true }),
      JSON.stringify({ ...body, Image: 'alpine:latest' }),
      JSON.stringify({ ...body, Binds: ['/:/host'] }),
      `${raw},"__proto__":{"Privileged":true,"HostConfig":{"Privileged":true}}}`,
      JSON.stringify([body]),
      '{"labId":',
    ];
    for (const text of json) {
      const res = await request(app).post('/v1/instances').set(auth).set('content-type', 'application/json').send(text);
      expect([res.status, res.body], text).toEqual([400, { error: 'bad_request' }]);
    }
    const form = await request(app).post('/v1/instances').set(auth).type('form').send(body);
    expect([form.status, form.body]).toEqual([400, { error: 'bad_request' }]);
    expect(stub.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(stub.containers().map((c) => c.name)).toEqual(['hvwa-range-traefik']);
  });

  it('Docker down is 502 "docker"', async () => {
    const { app, stub } = await setup();
    await stub.close();
    stubs.length = 0;
    const res = await request(app).get('/v1/instances').set(auth);
    expect([res.status, res.body]).toEqual([502, { error: 'docker' }]);
  });
});

describe('loadWardenConfig', () => {
  it('defaults, and the two requirements: the secret (32+) and the domain; the secret is never echoed', () => {
    const r = loadWardenConfig({ HVWA_WARDEN_SECRET: SECRET, HVWA_RANGE_DOMAIN: 'hvwa.my.id' });
    expect(r).toEqual({ ok: true, config: {
      host: '127.0.0.1', port: 8080, secret: SECRET, dockerUrl: 'http://socket-proxy:2375', registryPath: '/etc/hvwa/registry.json',
      domain: 'hvwa.my.id', traefikContainer: 'hvwa-range-traefik', runtime: 'runc',
    } });
    const bad = loadWardenConfig({ HVWA_WARDEN_SECRET: 'Short-Secret-Value', HVWA_RANGE_DOMAIN: 'hvwa.my.id' });
    expect(bad).toEqual({ ok: false, errors: ['HVWA_WARDEN_SECRET: must be at least 32 characters'] });
    expect(loadWardenConfig({})).toEqual({ ok: false, errors: ['HVWA_WARDEN_SECRET: is required', 'HVWA_RANGE_DOMAIN: is required'] });
    expect(loadWardenConfig({ HVWA_WARDEN_SECRET: SECRET, HVWA_RANGE_DOMAIN: 'x', HVWA_RANGE_RUNTIME: 'kata' }).ok).toBe(false);
    expect(loadWardenConfig({ HVWA_WARDEN_SECRET: SECRET, HVWA_RANGE_DOMAIN: 'x', HVWA_DOCKER_URL: 'unix:///var/run/docker.sock' }).ok).toBe(false);
  });

  it('HVWA_RANGE_RUNTIME=runsc (gVisor, the POC host) is taken as is', () => {
    const r = loadWardenConfig({ HVWA_WARDEN_SECRET: SECRET, HVWA_RANGE_DOMAIN: 'hvwa.my.id', HVWA_RANGE_RUNTIME: 'runsc' });
    expect(r.ok && r.config.runtime).toBe('runsc');
  });
});
