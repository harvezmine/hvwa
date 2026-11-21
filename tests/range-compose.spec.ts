// The range stack as text (Docker itself is exercised by `npm run range:verify`): behind the owner's Cloudflare Tunnel
// (external network hvwa-edge, alias traefik, no published port, no TLS, no cloudflared here), the networks of spec §3,
// the two socket proxies and their exact flags, pinned third-party images, who mounts the Docker socket (the proxies
// only), and Traefik's dynamic config matching the names the warden's container labels use.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { containerSpec } from '../src/warden/template.js';
import { testRegistry } from './support/range.js';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8').replace(/\r\n/g, '\n');
const yml = read('docker-compose.range.yml');
const dynamic = read('docker/range/traefik/range.yml');

/** The lines of a top-level service (`  <name>:` up to the next line indented 2 or less), comments dropped. */
function service(name: string): string[] {
  const lines = yml.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`no service ${name}`);
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !/^ {3,}/.test(line)) break;
    if (/^\s*#/.test(line)) continue;
    out.push(line);
  }
  return out;
}
const services = ['router', 'socket-proxy-ro', 'socket-proxy', 'warden', 'portal'];
const OFF = ['EXEC', 'IMAGES', 'VOLUMES', 'BUILD', 'COMMIT', 'DISTRIBUTION', 'AUTH', 'SECRETS', 'CONFIGS', 'SERVICES', 'SWARM', 'NODES',
  'TASKS', 'PLUGINS', 'SYSTEM', 'INFO', 'SESSION', 'GRPC', 'ALLOW_START', 'ALLOW_STOP', 'ALLOW_RESTARTS'];
/** The write proxy also allows exec (the one-shot flag write into a read-only rootfs); everything else stays off. */
const OFF_WRITE = OFF.filter((n) => n !== 'EXEC');
const env = (name: string, value: string) => `      ${name}: "${value}"`;

describe('docker-compose.range.yml', () => {
  it('has exactly the five platform services (no cloudflared), with pinned third-party images', () => {
    const names = yml.slice(yml.indexOf('\nservices:\n'), yml.indexOf('\nnetworks:\n')).split('\n')
      .filter((l) => /^ {2}[a-z-]+:$/.test(l)).map((l) => l.trim().slice(0, -1));
    expect(names).toEqual(services);
    expect(yml).not.toMatch(/^ {2}cloudflared:/m);
    expect(service('router')).toContain('    image: traefik:v3.7.19');
    expect(service('socket-proxy')).toContain('    image: tecnativa/docker-socket-proxy:v0.5.0');
    expect(service('socket-proxy-ro')).toContain('    image: tecnativa/docker-socket-proxy:v0.5.0');
    expect(service('warden')).toContain('    image: sigmajo/hvwa:range-warden-${HVWA_RANGE_VERSION:-0.1.0}');
    expect(service('portal')).toContain('    image: sigmajo/hvwa:range-portal-${HVWA_RANGE_VERSION:-0.1.0}');
  });

  it('publishes no port at all and configures no TLS: Cloudflare terminates TLS, cloudflared is the only way in', () => {
    for (const name of services) expect(/\n {4}ports:/.test(`\n${service(name).join('\n')}`), name).toBe(false);
    expect(service('router').join('\n')).not.toMatch(/WEBSECURE|CERTIFICATESRESOLVERS|ACME|_TLS|REDIRECTIONS/);
  });

  it('the router joins the external hvwa-edge network as `traefik` (only there), and edge + traefik-ro', () => {
    expect(service('router').join('\n')).toContain('    networks:\n      hvwa-edge:\n        aliases: [traefik]\n      edge: {}\n      traefik-ro: {}');
    const nets = yml.slice(yml.indexOf('\nnetworks:\n'));
    expect(nets).toContain('  hvwa-edge:\n    external: true\n    name: ${HVWA_EDGE_NETWORK:-hvwa-edge}');
    for (const n of ['edge', 'control', 'docker', 'traefik-ro']) {
      expect(nets).toContain(`  ${n}:\n    internal: true\n    driver_opts:\n      com.docker.network.bridge.gateway_mode_ipv4: isolated`);
    }
    expect(service('portal')).toContain('    networks: [edge, control]');
    expect(service('warden')).toContain('    networks: [control, docker]');
  });

  it('one entrypoint on port 80, bound at start to the hvwa-edge address (the alias traefik), never 0.0.0.0', () => {
    const r = service('router');
    expect(r).toEqual(expect.arrayContaining([
      '    entrypoint: ["/bin/sh", "-ec"]',
      '        addr="$$(getent hosts traefik | awk \'NR==1 {print $$1}\')"',
      '        export TRAEFIK_ENTRYPOINTS_WEB_ADDRESS="$$addr:80" TRAEFIK_ENTRYPOINTS_WEB_ASDEFAULT=true',
      '        exec traefik',
      '      net.ipv4.ip_unprivileged_port_start: 0',
      '      TRAEFIK_ENTRYPOINTS_PING_ADDRESS: "127.0.0.1:8082"',
      '      TRAEFIK_PROVIDERS_DOCKER_ENDPOINT: "tcp://socket-proxy-ro:2375"',
      '      TRAEFIK_PROVIDERS_DOCKER_EXPOSEDBYDEFAULT: "false"',
      '      TRAEFIK_PROVIDERS_DOCKER_CONSTRAINTS: "Label(`hvwa.range`,`1`)"',
      '      TRAEFIK_PROVIDERS_FILE_DIRECTORY: "/etc/traefik/dynamic"',
      '      TRAEFIK_API: "false"',
      '      - ./docker/range/traefik:/etc/traefik/dynamic:ro',
    ]));
    expect(r.join('\n')).not.toMatch(/TRAEFIK_ENTRYPOINTS_WEB_ADDRESS: /); // never a fixed (all-interfaces) address
  });

  it('the write proxy: containers, networks, exec (the flag write), POST; nothing else; on `docker` only', () => {
    expect(service('socket-proxy')).toEqual(expect.arrayContaining([env('CONTAINERS', '1'), env('NETWORKS', '1'), env('POST', '1'),
      env('EXEC', '1'), env('EVENTS', '0'), env('PING', '1'), env('VERSION', '1'), ...OFF_WRITE.map((n) => env(n, '0')), '    networks: [docker]']));
  });

  it('the portal shares no network with the write socket proxy: only the warden joins `docker`', () => {
    const networkNames = (name: string) => {
      const line = service(name).find((l) => l.startsWith('    networks: [')) ?? '';
      return line.slice(line.indexOf('[') + 1, line.lastIndexOf(']')).split(',').map((n) => n.trim()).filter(Boolean);
    };
    const portal = networkNames('portal');
    const warden = networkNames('warden');
    expect(networkNames('socket-proxy')).toEqual(['docker']);
    expect(warden).toEqual(['control', 'docker']);
    expect(portal).toEqual(['edge', 'control']);
    expect(portal.filter((n) => n === 'docker')).toEqual([]);
  });

  it('the read-only proxy: containers, networks, events, no POST; on `traefik-ro` only', () => {
    expect(service('socket-proxy-ro')).toEqual(expect.arrayContaining([env('CONTAINERS', '1'), env('NETWORKS', '1'), env('POST', '0'),
      env('EVENTS', '1'), env('PING', '1'), env('VERSION', '1'), ...OFF.map((n) => env(n, '0')), '    networks: [traefik-ro]']));
  });

  it('only the two proxies mount the Docker socket, read-only', () => {
    for (const name of services) {
      const s = service(name).join('\n');
      expect(s.includes('/var/run/docker.sock'), name).toBe(name.startsWith('socket-proxy'));
      if (name.startsWith('socket-proxy')) expect(s).toContain('      - /var/run/docker.sock:/var/run/docker.sock:ro');
    }
  });

  it('every service is hardened: read-only rootfs, no capabilities, no new privileges, limits; Traefik not root', () => {
    for (const name of services) {
      expect(service(name), name).toEqual(expect.arrayContaining(['    read_only: true', '    cap_drop: [ALL]',
        '    security_opt: ["no-new-privileges:true"]']));
      expect(service(name).some((l) => l.startsWith('    pids_limit: ')), name).toBe(true);
      expect(service(name).some((l) => l.startsWith('    mem_limit: ')), name).toBe(true);
    }
    expect(service('router')).toContain('    user: "65532:65532"');
  });

  it('the portal: portal mode, the public scheme (https behind the tunnel), no trusted proxy; the warden: runtime and proxy', () => {
    const p = service('portal');
    expect(p).toEqual(expect.arrayContaining(['      HVWA_MODE: portal', '      HVWA_RANGE_PUBLIC_SCHEME: "${HVWA_RANGE_PUBLIC_SCHEME:-https}"',
      '      HVWA_WARDEN_URL: http://warden:8080', '      HVWA_LAB_REGISTRY: /etc/hvwa/registry.json', '      HVWA_FORWARD_AUTH_HOST: portal']));
    expect(p.join('\n')).not.toMatch(/TRUST_PROXY/);
    expect(service('warden')).toEqual(expect.arrayContaining(['      HVWA_DOCKER_URL: http://socket-proxy:2375',
      '      HVWA_RANGE_RUNTIME: "${HVWA_RANGE_RUNTIME:-runsc}"', '      HVWA_TRAEFIK_CONTAINER: "${HVWA_TRAEFIK_CONTAINER:-hvwa-range-traefik}"']));
    expect(service('router')).toContain('    container_name: "${HVWA_TRAEFIK_CONTAINER:-hvwa-range-traefik}"');
  });

  it('the compact POC: no Extend, ceiling, event code or registration code; idle 20 min, lifetime 60 min', () => {
    const p = service('portal').join('\n');
    expect(p).not.toMatch(/HVWA_RANGE_(?:EXTEND|CEILING)/);
    expect(p).not.toMatch(/HVWA_REGISTRATION_CODE/);
    expect(service('portal')).toEqual(expect.arrayContaining([
      '      HVWA_RANGE_IDLE_MIN: "${HVWA_RANGE_IDLE_MIN:-20}"',
      '      HVWA_RANGE_MAX_MIN: "${HVWA_RANGE_MAX_MIN:-60}"',
      '      HVWA_REGISTRATION_OPEN: "${HVWA_REGISTRATION_OPEN:-1}"',
    ]));
    expect(yml).not.toMatch(/EXTEND_MIN|CEILING_MIN|REGISTRATION_CODE/);
  });
});

describe('docker/range/traefik/range.yml', () => {
  it('forward-auth to the portal with the secret header set before and removed after; Traefik trusts no client X-Forwarded-*', () => {
    expect(dynamic).toContain('    hvwa-forward-auth:\n      forwardAuth:\n        address: "http://portal:1337/__hvwa/auth"\n        trustForwardHeader: false\n        authRequestHeaders:\n          - Cookie\n          - X-Hvwa-Auth-Secret');
    expect(dynamic).toContain('    hvwa-auth-secret:\n      headers:\n        customRequestHeaders:\n          X-Hvwa-Auth-Secret: \'{{ env "HVWA_FORWARD_AUTH_SECRET" }}\'');
    expect(dynamic).toContain('    hvwa-strip-secret:\n      headers:\n        customRequestHeaders:\n          X-Hvwa-Auth-Secret: ""');
    expect(dynamic).toContain('    hvwa-instance:\n      chain:\n        middlewares:\n          - hvwa-auth-secret\n          - hvwa-forward-auth\n          - hvwa-strip-secret');
    expect(dynamic).not.toMatch(/^\s*(tls|certResolver):/m); // no TLS section: Cloudflare terminates TLS
  });

  it('the portal router and service, and exactly the names the warden\'s labels reference', () => {
    expect(dynamic).toContain("      rule: 'Host(`{{ env \"HVWA_PORTAL_HOST\" }}`)'");
    expect(dynamic).toContain('        servers:\n          - url: "http://portal:1337"');
    const labels = containerSpec({ lab: testRegistry().get('r01')!, level: 'acolyte', instanceId: 'a'.repeat(26), userId: 1, expiresAt: 1 },
      { domain: 'localhost', runtime: 'runc' }).body.Labels as Record<string, string>;
    const refs = Object.entries(labels).filter(([k]) => /\.(middlewares|service)$/.test(k)).map(([, v]) => v).filter((v) => v.endsWith('@file'));
    expect(refs.sort()).toEqual(['hvwa-instance@file', 'hvwa-portal@file']);
    expect(dynamic).toContain('    hvwa-instance:\n');
    expect(dynamic).toContain('    hvwa-portal:\n      loadBalancer:');
  });
});
