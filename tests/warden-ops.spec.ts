// The warden's operations (src/warden/warden.ts) against the stub Engine: launch builds the network, the container from
// the registry's digest-pinned image with the fixed template, connects Traefik and starts it, then (below Divine) runs a
// one-shot exec to write the flag file, and cleans up after any failure; stop is idempotent; list and health read labels
// and State.Health. Only container, network and exec endpoints.
import { describe, it, expect, afterEach } from 'vitest';
import { createDockerClient, DOCKER_API } from '../src/warden/docker.js';
import { containerSpec, networkSpec } from '../src/warden/template.js';
import { createWarden } from '../src/warden/warden.js';
import { WardenError, type LaunchRequest } from '../src/warden/protocol.js';
import { startDockerStub, type DockerStub } from './support/docker-stub.js';
import { testRegistry } from './support/range.js';

const ID = 'abcdefghijklmnopqrstuvwxyz';
const ID2 = 'zyxwvutsrqponmlkjihgfedcba';
const FLAG = 'HVWA{abcdefghijklmnopqrstuvwxyz}'; // 26 base32 characters (RANGE_FLAG_RE)
const SETTINGS = { domain: 'hvwa.my.id', runtime: 'runc' as const, traefikContainer: 'hvwa-range-traefik' };
const stubs: DockerStub[] = [];
afterEach(async () => { for (const s of stubs.splice(0)) await s.close(); });

async function setup() {
  const stub = await startDockerStub();
  stubs.push(stub);
  const registry = testRegistry();
  for (const lab of registry.labs) stub.images.set(lab.image, { healthcheck: true });
  stub.addContainer('hvwa-range-traefik');
  const warden = createWarden({ docker: createDockerClient(stub.url), registry, settings: SETTINGS });
  return { stub, warden, registry };
}
const req = (over: Partial<LaunchRequest> = {}): LaunchRequest =>
  ({ labId: 'r01', level: 'acolyte', instanceId: ID, flag: FLAG, userId: 7, expiresAt: 1_800_000_000_000, ...over });

describe('launch', () => {
  it('network, container (template, registry image), Traefik connected, started, flag written by exec: in that order', async () => {
    const { stub, warden, registry } = await setup();
    await warden.launch(req());
    const writes = stub.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path.split('?')[0]}`);
    expect(writes).toEqual([
      `POST ${DOCKER_API}/networks/create`,
      `POST ${DOCKER_API}/containers/create`,
      `POST ${DOCKER_API}/networks/hvwa-i-${ID}/connect`,
      `POST ${DOCKER_API}/containers/hvwa-i-${ID}/start`,
      `POST ${DOCKER_API}/containers/hvwa-i-${ID}/exec`,
      `POST ${DOCKER_API}/exec/${stub.execs()[0].id}/start`,
    ]);
    expect(stub.calls.find((c) => c.path.startsWith(`${DOCKER_API}/networks/create`))?.body).toEqual(networkSpec(ID));
    const lab = registry.get('r01')!;
    const { body } = containerSpec({ lab, level: 'acolyte', instanceId: ID, userId: 7, expiresAt: 1_800_000_000_000 }, SETTINGS);
    expect(stub.container(`hvwa-i-${ID}`)?.body).toEqual(body);
    expect([...stub.network(`hvwa-i-${ID}`)!.containers].sort()).toEqual(['hvwa-range-traefik', `hvwa-i-${ID}`].sort());
    expect(stub.container(`hvwa-i-${ID}`)?.status).toBe('running');
    const [exec] = stub.execs();
    expect(exec.container).toBe(`hvwa-i-${ID}`);
    expect(exec.started).toBe(true);
    expect(exec.config).toMatchObject({ User: '10001:10001', AttachStdin: false, AttachStdout: false, AttachStderr: false, Tty: false });
    expect((exec.config.Cmd as string[]).at(-1)).toBe(FLAG); // the flag is argv[1] of the shell, never in the container Env
  });

  it('retries the next instance subnet when Docker reports an address-pool overlap', async () => {
    const { stub, warden } = await setup();
    stub.failNext('POST', new RegExp(`^${DOCKER_API}/networks/create$`), 403, 'Pool overlaps with other one on this address space');
    await warden.launch(req());
    const creates = stub.calls.filter((c) => c.method === 'POST' && c.path === `${DOCKER_API}/networks/create`);
    expect(creates).toHaveLength(2);
    expect(creates[0].body).toEqual(networkSpec(ID));
    expect(creates[1].body).toEqual(networkSpec(ID, 1));
    expect(stub.network(`hvwa-i-${ID}`)?.body).toEqual(networkSpec(ID, 1));
  });

  it('does not retry a network name that already exists', async () => {
    const { stub, warden } = await setup();
    stub.failNext('POST', new RegExp(`^${DOCKER_API}/networks/create$`), 409, `network with name hvwa-i-${ID} already exists`);
    await expect(warden.launch(req())).rejects.toBeInstanceOf(WardenError);
    const creates = stub.calls.filter((c) => c.method === 'POST' && c.path === `${DOCKER_API}/networks/create`);
    expect(creates).toHaveLength(1);
  });

  it('Divine runs no flag exec: the launch is network, container, connect, start only', async () => {
    const { stub, warden } = await setup();
    await warden.launch(req({ level: 'divine', flag: undefined }));
    const writes = stub.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path.split('?')[0]}`);
    expect(writes).toEqual([
      `POST ${DOCKER_API}/networks/create`,
      `POST ${DOCKER_API}/containers/create`,
      `POST ${DOCKER_API}/networks/hvwa-i-${ID}/connect`,
      `POST ${DOCKER_API}/containers/hvwa-i-${ID}/start`,
    ]);
    expect(stub.execs()).toEqual([]);
  });

  it('refuses what the registry does not allow, before touching Docker: unknown lab, level, flag rules, extra keys', async () => {
    const { stub, warden } = await setup();
    const cases: [unknown, string][] = [
      [req({ labId: 'r42' }), 'unknown_lab'],
      [req({ labId: 'r02', level: 'templar' }), 'bad_level'],
      [req({ level: 'divine' }), 'bad_request'],                 // a flag at Divine
      [{ ...req(), flag: undefined }, 'bad_request'],             // no flag below Divine
      [{ ...req(), image: 'alpine:latest' }, 'bad_request'],
      [{ ...req(), HostConfig: { Privileged: true } }, 'bad_request'],
      [{ ...req(), Privileged: true }, 'bad_request'],
      [req({ instanceId: '../../etc' }), 'bad_request'],
    ];
    for (const [body, code] of cases) {
      await expect(warden.launch(body as LaunchRequest), code).rejects.toMatchObject({ code });
    }
    expect(stub.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('an existing instance is 409 "exists"; a Docker failure midway is "docker" and leaves nothing behind', async () => {
    const { stub, warden } = await setup();
    await warden.launch(req());
    await expect(warden.launch(req())).rejects.toMatchObject({ code: 'exists', status: 409 });
    stub.failNext('POST', /\/containers\/[^/]+\/start$/, 500);
    await expect(warden.launch(req({ instanceId: ID2 }))).rejects.toMatchObject({ code: 'docker', status: 502 });
    expect(stub.container(`hvwa-i-${ID2}`)).toBeUndefined();
    expect(stub.network(`hvwa-i-${ID2}`)).toBeUndefined();
    expect([...stub.container('hvwa-range-traefik')!.networks]).toEqual([`hvwa-i-${ID}`]);
  });

  it('a failed flag exec is "docker" and leaves nothing behind', async () => {
    const { stub, warden } = await setup();
    stub.failNext('POST', /\/exec\/[^/]+\/start$/, 500);
    await expect(warden.launch(req())).rejects.toMatchObject({ code: 'docker', status: 502 });
    expect(stub.container(`hvwa-i-${ID}`)).toBeUndefined();
    expect(stub.network(`hvwa-i-${ID}`)).toBeUndefined();
    expect([...stub.container('hvwa-range-traefik')!.networks]).toEqual([]);
  });

  it('one operation at a time per instance: of two launches of one id, one starts it and the other is "exists"', async () => {
    const { stub, warden } = await setup();
    const results = await Promise.allSettled([warden.launch(req()), warden.launch(req())]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'exists', status: 409 });
    expect(stub.container(`hvwa-i-${ID}`)?.status).toBe('running');
    expect([...stub.network(`hvwa-i-${ID}`)!.containers].sort()).toEqual(['hvwa-range-traefik', `hvwa-i-${ID}`].sort());
    await Promise.all([warden.stop(ID), warden.launch(req({ instanceId: ID2 })), warden.stop(ID)]);
    expect(stub.container(`hvwa-i-${ID}`)).toBeUndefined();
    expect(stub.network(`hvwa-i-${ID}`)).toBeUndefined();
    expect(stub.container(`hvwa-i-${ID2}`)?.status).toBe('running');
  });

  it('a lab whose image is not on the host fails as "docker" and cleans up', async () => {
    const { stub, warden } = await setup();
    stub.images.clear();
    await expect(warden.launch(req())).rejects.toBeInstanceOf(WardenError);
    expect(stub.networks()).toEqual([]);
  });
});

describe('stop, list, health', () => {
  it('stop removes the container, disconnects Traefik, removes the network; twice is fine; a bad id is refused', async () => {
    const { stub, warden } = await setup();
    await warden.launch(req());
    await warden.stop(ID);
    expect(stub.container(`hvwa-i-${ID}`)).toBeUndefined();
    expect(stub.network(`hvwa-i-${ID}`)).toBeUndefined();
    expect([...stub.container('hvwa-range-traefik')!.networks]).toEqual([]);
    await warden.stop(ID);
    await expect(warden.stop('nope')).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('list reads only hvwa.range=1 containers, from their labels', async () => {
    const { stub, warden } = await setup();
    await warden.launch(req());
    stub.addContainer('unrelated', { 'other.label': 'x' });
    expect(await warden.list()).toEqual([{ instanceId: ID, labId: 'r01', level: 'acolyte', userId: 7, expiresAt: 1_800_000_000_000, state: 'running' }]);
  });

  it('health: starting, then ready once the image\'s health check passes; failed (unhealthy, exited, oom, no_healthcheck); missing', async () => {
    const { stub, warden, registry } = await setup();
    await warden.launch(req());
    expect(await warden.health(ID)).toEqual({ status: 'starting' });
    stub.setHealth(`hvwa-i-${ID}`, 'healthy');
    expect(await warden.health(ID)).toEqual({ status: 'ready' });
    stub.setHealth(`hvwa-i-${ID}`, 'unhealthy');
    expect(await warden.health(ID)).toEqual({ status: 'failed', reason: 'unhealthy' });
    stub.exit(`hvwa-i-${ID}`, 137, true);
    expect(await warden.health(ID)).toEqual({ status: 'failed', reason: 'oom' });
    stub.exit(`hvwa-i-${ID}`, 1);
    expect(await warden.health(ID)).toEqual({ status: 'failed', reason: 'exited' });
    stub.images.set(registry.get('r02')!.image, { healthcheck: false });
    await warden.launch(req({ instanceId: ID2, labId: 'r02', level: 'acolyte' }));
    expect(await warden.health(ID2)).toEqual({ status: 'failed', reason: 'no_healthcheck' });
    expect(await warden.health('a'.repeat(26))).toEqual({ status: 'missing' });
  });

  it('never calls anything but containers, networks, exec and _ping', async () => {
    const { stub, warden } = await setup();
    await warden.launch(req());
    await warden.health(ID);
    await warden.list();
    await warden.stop(ID);
    expect(stub.unexpected).toEqual([]);
    for (const c of stub.calls) expect(c.path).toMatch(/^(\/_ping|\/v1\.44\/(containers|networks|exec)[/?])/);
    expect(stub.calls.some((c) => /\/(images|volumes|swarm|system|build|plugins|secrets|configs)\b/.test(c.path))).toBe(false);
  });
});
