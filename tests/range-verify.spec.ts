// scripts/range-verify.mjs's pure parts: the hardening comparison (pinned to what src/warden/template.ts creates for the
// fixture lab, as Docker reports it back, for runc and runsc) and the probe classification; and its safety: its own
// compose project and networks, no prune, no run beside another range.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyProbe, expectedHostConfig, hardeningProblems, PROJECT } from '../scripts/range-verify.mjs';
import { parseRegistry } from '../src/lab-registry.js';
import { containerSpec, type Runtime } from '../src/warden/template.js';

const ID = 'abcdefghijklmnopqrstuvwxyz';
const TRAEFIK = 'hvwa-range-verify-traefik';
const fixture = parseRegistry({ schema: 1, labs: [{
  ...JSON.parse(readFileSync(join(process.cwd(), 'labs', '_fixture', 'lab.json'), 'utf8')), version: '0.0.0', image: `sha256:${'f'.repeat(64)}`,
}] }).get('r00')!;

/** What `docker container inspect` / `docker network inspect` report for a container made from the template. */
function reported(runtime: Runtime = 'runc') {
  const { body } = containerSpec({ lab: fixture, level: 'templar', instanceId: ID, flag: `HVWA{${'a'.repeat(26)}}`, userId: 1, expiresAt: 1 },
    { domain: 'localhost', runtime });
  const hc = body.HostConfig as Record<string, unknown>;
  return {
    container: {
      HostConfig: { ...hc, CapAdd: null, Binds: null, Mounts: null, Devices: [], VolumesFrom: null, PortBindings: {} } as Record<string, unknown>,
      Mounts: [], Config: { User: body.User as string, Labels: body.Labels as Record<string, string> },
    },
    network: {
      Internal: true, Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
      Containers: { a: { Name: `hvwa-i-${ID}` }, b: { Name: TRAEFIK } } as Record<string, { Name: string }>,
    },
  };
}

describe('hardeningProblems', () => {
  it('finds nothing in exactly what the template creates (expectedHostConfig agrees with src/warden/template.ts)', () => {
    for (const runtime of ['runc', 'runsc'] as const) {
      const { container, network } = reported(runtime);
      expect(hardeningProblems(container, network, ID, TRAEFIK, runtime), runtime).toEqual([]);
      for (const [k, v] of Object.entries(expectedHostConfig(runtime))) expect(container.HostConfig[k], `${runtime} ${k}`).toEqual(v);
    }
    const { container, network } = reported('runc');
    expect(hardeningProblems(container, network, ID, TRAEFIK, 'runsc').join('\n')).toContain('HostConfig.Runtime');
  });

  it('names every weakening', () => {
    const { container, network } = reported();
    const weak = {
      ...container,
      HostConfig: { ...container.HostConfig, Privileged: true, CapAdd: ['NET_ADMIN'], Binds: ['/:/host'], ReadonlyRootfs: false,
        SecurityOpt: ['seccomp=unconfined'], PortBindings: { '8080/tcp': [{ HostPort: '8080' }] } },
      Config: { ...container.Config, User: 'root' },
    };
    const leaky = { ...network, Internal: false, Containers: { ...network.Containers, c: { Name: 'hvwa-range-verify-portal-1' } } };
    const text = hardeningProblems(weak, leaky, ID, TRAEFIK).join('\n');
    for (const want of ['HostConfig.Privileged', 'HostConfig.CapAdd', 'HostConfig.Binds', 'HostConfig.ReadonlyRootfs', 'HostConfig.SecurityOpt',
      'unconfined', 'HostConfig.PortBindings', 'User is "root"', 'not internal', 'the instance network holds']) {
      expect(text, want).toContain(want);
    }
  });
});

describe('classifyProbe', () => {
  it('blocked = nothing answered; refused = a host said no; anything else = reached', () => {
    for (const o of ['ETIMEDOUT', 'TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND']) expect(classifyProbe(o), o).toBe('blocked');
    expect(classifyProbe('ECONNREFUSED')).toBe('refused');
    for (const o of ['CONNECTED', 'ECONNRESET', '', 'something else']) expect(classifyProbe(o), o).toBe('reached');
  });
});

describe('the script', () => {
  it('uses its own compose project, edge network and tunnel stand-in, never prunes, and refuses to run beside another range', () => {
    const src = readFileSync(join(process.cwd(), 'scripts', 'range-verify.mjs'), 'utf8');
    expect(PROJECT).toBe('hvwa-range-verify');
    expect(src).toContain("const COMPOSE = ['compose', '-f', COMPOSE_FILE, '-p', PROJECT];");
    expect(src).toContain('const EDGE_NETWORK = `${PROJECT}-edge`;');
    expect(src).toContain('const TUNNEL = `${PROJECT}-tunnel`;');
    expect(src).not.toMatch(/\bprune\b/);
    expect(src).toContain("'label=hvwa.range=1'");
    expect(src).toContain('BLOCKED');
  });
});
