// THE container configuration of every range instance (src/warden/template.ts, spec range §7), pinned field by field:
// a change here is a security change. And the instance's own network: internal, isolated gateway, labelled.
import { describe, it, expect } from 'vitest';
import { parseRegistry } from '../src/lab-registry.js';
import { containerSpec, LAB_USER, networkSpec } from '../src/warden/template.js';
import { labEntry, testRegistry } from './support/range.js';

const ID = 'abcdefghijklmnopqrstuvwxyz';
const SETTINGS = { domain: 'hvwa.my.id', runtime: 'runc' as const };
const MIB = 1024 * 1024;

describe('containerSpec', () => {
  it('is exactly spec §7 for a lab with the default limits', () => {
    const lab = testRegistry().get('r01')!;
    const { name, body } = containerSpec({ lab, level: 'templar', instanceId: ID, userId: 7, expiresAt: 1_800_000_000_000 }, SETTINGS);
    expect(name).toBe(`hvwa-i-${ID}`);
    expect(body).toEqual({
      Image: lab.image,
      User: '10001:10001',
      Env: ['HVWA_LEVEL=templar', 'HVWA_PORT=8080', `HVWA_INSTANCE_HOST=i-${ID}.hvwa.my.id`, 'HOME=/tmp', 'HVWA_FLAG_FILE=/tmp/.hvwa-flag'],
      Labels: {
        'hvwa.range': '1', 'hvwa.instance': ID, 'hvwa.user': '7', 'hvwa.lab': 'r01', 'hvwa.level': 'templar', 'hvwa.expires': '1800000000000',
        'traefik.enable': 'true',
        'traefik.docker.network': `hvwa-i-${ID}`,
        [`traefik.http.routers.i-${ID}.rule`]: `Host(\`i-${ID}.hvwa.my.id\`)`,
        [`traefik.http.routers.i-${ID}.priority`]: '10',
        [`traefik.http.routers.i-${ID}.middlewares`]: 'hvwa-instance@file',
        [`traefik.http.routers.i-${ID}.service`]: `i-${ID}`,
        [`traefik.http.services.i-${ID}.loadbalancer.server.port`]: '8080',
        [`traefik.http.routers.g-${ID}.rule`]: `Host(\`i-${ID}.hvwa.my.id\`) && PathPrefix(\`/__hvwa/\`)`,
        [`traefik.http.routers.g-${ID}.priority`]: '1000',
        [`traefik.http.routers.g-${ID}.service`]: 'hvwa-portal@file',
      },
      Healthcheck: { Test: [], Interval: 2_000_000_000, Timeout: 2_000_000_000, Retries: 3, StartPeriod: 60_000_000_000, StartInterval: 500_000_000 },
      StopTimeout: 2,
      HostConfig: {
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=64m' },
        CapDrop: ['ALL'],
        CapAdd: [],
        SecurityOpt: ['no-new-privileges:true'],
        Privileged: false,
        PidsLimit: 128,
        Memory: 256 * MIB,
        MemorySwap: 256 * MIB,
        NanoCpus: 500_000_000,
        NetworkMode: `hvwa-i-${ID}`,
        PortBindings: {},
        PublishAllPorts: false,
        Binds: [],
        Mounts: [],
        VolumesFrom: [],
        Devices: [],
        RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
        Runtime: 'runc',
        IpcMode: 'private',
        LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
      },
      NetworkingConfig: { EndpointsConfig: { [`hvwa-i-${ID}`]: {} } },
    });
  });

  it('spec §7 row by row: non-root, read-only, no capabilities, no new privileges, default seccomp, no swap, no mounts, no ports', () => {
    const { body } = containerSpec({ lab: testRegistry().get('r01')!, level: 'acolyte', instanceId: ID, userId: 1, expiresAt: 1 }, SETTINGS);
    const hc = body.HostConfig as Record<string, unknown>;
    expect(Number(LAB_USER.split(':')[0])).toBeGreaterThanOrEqual(1000);
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.CapDrop).toEqual(['ALL']);
    expect(hc.CapAdd).toEqual([]);
    expect(hc.SecurityOpt).toEqual(['no-new-privileges:true']); // nothing like seccomp=unconfined: Docker's default profile applies
    expect(hc.MemorySwap).toBe(hc.Memory);
    expect([hc.Binds, hc.Mounts, hc.Devices, hc.VolumesFrom]).toEqual([[], [], [], []]);
    expect([hc.PortBindings, hc.PublishAllPorts]).toEqual([{}, false]);
    expect(hc.RestartPolicy).toEqual({ Name: 'no', MaximumRetryCount: 0 });
  });

  it('a manifest may only lower the limits; its tmpfs list is used; Divine gets no flag env; runsc when asked', () => {
    const lab = parseRegistry({ schema: 1, labs: [labEntry('r05', 'beacon', {
      port: 3000, resources: { memoryMiB: 128, pids: 64, cpus: 0.25 }, tmpfs: [{ path: '/tmp', sizeMiB: 16 }, { path: '/var/run/beacon', sizeMiB: 8 }],
    })] }).get('r05')!;
    const { body } = containerSpec({ lab, level: 'divine', instanceId: ID, userId: 2, expiresAt: 3 }, { domain: 'localhost', runtime: 'runsc' });
    const hc = body.HostConfig as Record<string, unknown>;
    expect([hc.Memory, hc.MemorySwap, hc.PidsLimit, hc.NanoCpus, hc.Runtime]).toEqual([128 * MIB, 128 * MIB, 64, 250_000_000, 'runsc']);
    expect(hc.Tmpfs).toEqual({ '/tmp': 'rw,noexec,nosuid,nodev,size=16m', '/var/run/beacon': 'rw,noexec,nosuid,nodev,size=8m' });
    expect(body.Env).toEqual(['HVWA_LEVEL=divine', 'HVWA_PORT=3000', `HVWA_INSTANCE_HOST=i-${ID}.localhost`, 'HOME=/tmp', 'HVWA_FLAG_FILE=/tmp/.hvwa-flag']);
    expect((body.Labels as Record<string, string>)[`traefik.http.services.i-${ID}.loadbalancer.server.port`]).toBe('3000');
  });
});

describe('networkSpec', () => {
  it('one internal bridge per instance, no host address on it, labelled for reconcile', () => {
    expect(networkSpec(ID)).toEqual({
      Name: `hvwa-i-${ID}`, Driver: 'bridge', Internal: true, Attachable: false, EnableIPv6: false,
      Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
      Labels: { 'hvwa.range': '1', 'hvwa.instance': ID },
    });
  });
});
