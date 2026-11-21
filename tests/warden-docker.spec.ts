// The warden's Docker Engine API client (src/warden/docker.ts) against the stub Engine: versioned container and network
// endpoints only, the Engine's status codes turned into DockerError, 404 on removal tolerated (idempotent stop).
import { describe, it, expect, afterEach } from 'vitest';
import { createDockerClient, DOCKER_API, DockerError } from '../src/warden/docker.js';
import { startDockerStub, type DockerStub } from './support/docker-stub.js';

const stubs: DockerStub[] = [];
afterEach(async () => { for (const s of stubs.splice(0)) await s.close(); });
async function setup() {
  const stub = await startDockerStub();
  stubs.push(stub);
  stub.images.set('img@sha256:x', { healthcheck: true });
  return { stub, docker: createDockerClient(stub.url) };
}

describe('createDockerClient', () => {
  it('creates a network and a container on it, starts it, inspects it, lists it by label, removes both', async () => {
    const { stub, docker } = await setup();
    await docker.ping();
    expect(await docker.createNetwork({ Name: 'net-a', Internal: true })).toMatch(/^[0-9a-f]{64}$/);
    await docker.createContainer('box-a', { Image: 'img@sha256:x', Labels: { 'hvwa.range': '1' }, HostConfig: { NetworkMode: 'net-a' } });
    await docker.startContainer('box-a');
    await docker.startContainer('box-a'); // 304: already running is fine
    const info = await docker.inspectContainer('box-a');
    expect(info?.State).toMatchObject({ Status: 'running', Running: true, Health: { Status: 'starting' } });
    expect((await docker.listContainers('hvwa.range=1')).map((c) => c.Names[0])).toEqual(['/box-a']);
    expect(await docker.listContainers('hvwa.range=2')).toEqual([]);
    await docker.removeContainer('box-a');
    await docker.removeContainer('box-a'); // 404: already gone is fine
    expect(await docker.inspectContainer('box-a')).toBeUndefined();
    await docker.removeNetwork('net-a');
    await docker.removeNetwork('net-a');
    expect(stub.networks()).toEqual([]);
    expect(stub.unexpected).toEqual([]);
    for (const c of stub.calls) expect(c.path, c.path).toMatch(new RegExp(`^(/_ping|${DOCKER_API.replace('.', '\\.')}/(containers|networks)[/?])`));
  });

  it('turns Engine errors into DockerError with the status and the Engine\'s message', async () => {
    const { stub, docker } = await setup();
    await docker.createNetwork({ Name: 'net-b' });
    await expect(docker.createNetwork({ Name: 'net-b' })).rejects.toMatchObject({ name: 'DockerError', status: 409 });
    await expect(docker.createContainer('box-b', { Image: 'missing@sha256:y', HostConfig: { NetworkMode: 'net-b' } }))
      .rejects.toThrow(/No such image/);
    stub.addContainer('peer');
    await docker.connectNetwork('net-b', 'peer');
    await expect(docker.removeNetwork('net-b')).rejects.toMatchObject({ status: 403 });
    await docker.disconnectNetwork('net-b', 'peer');
    await docker.disconnectNetwork('net-b', 'peer'); // not connected any more: tolerated
    await docker.removeNetwork('net-b');
  });

  it('an unreachable Engine is a DockerError with status 0, never an unhandled fetch error', async () => {
    const { stub } = await setup();
    const url = stub.url;
    await stub.close();
    stubs.length = 0;
    const err = await createDockerClient(url, { timeoutMs: 2000 }).ping().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect((err as DockerError).status).toBe(0);
  });
});
