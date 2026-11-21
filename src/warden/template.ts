// src/warden/template.ts — THE configuration of every range instance container (spec range §7) and of its network.
// Fixed here: the portal passes only identifiers (protocol.ts); the image comes from the registry, pinned by digest;
// a manifest may only lower the limits (src/lab-registry.ts caps them). tests/warden-template.spec.ts pins every field.
//
// Network: its own `internal` bridge (no default route: no egress, no other instance, no portal), with an isolated
// gateway (the host gets no address on it), shared only with Traefik, which the warden connects after creating it.
// Traefik's only entrypoint listens on its hvwa-edge address (the tunnel's side) only, so the instance finds nothing
// listening on its side either.
import type { Level } from '../core/levels.js';
import { LAB_LIMITS, type LabEntry } from '../lab-registry.js';

/** Every lab process runs as this uid:gid (spec §7: non-root, uid >= 1000). HOME is /tmp (the rootfs is read-only). */
export const LAB_USER = '10001:10001';
export const RANGE_LABEL = 'hvwa.range';
export const RUNTIMES = Object.freeze(['runc', 'runsc'] as const);
export type Runtime = (typeof RUNTIMES)[number];
export interface TemplateSettings {
  /** HVWA_RANGE_DOMAIN: the lab answers at i-<instanceId>.<domain>. */
  readonly domain: string;
  /** HVWA_RANGE_RUNTIME: runc, or runsc (gVisor) where installed; the POC host requires runsc (always written as HostConfig.Runtime). */
  readonly runtime: Runtime;
}

const MIB = 1024 * 1024;
/** The container and its network share one name. */
export const instanceResourceName = (instanceId: string) => `hvwa-i-${instanceId}`;

export function networkSpec(instanceId: string) {
  return {
    Name: instanceResourceName(instanceId),
    Driver: 'bridge',
    Internal: true,
    Attachable: false,
    EnableIPv6: false,
    Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
    Labels: { [RANGE_LABEL]: '1', 'hvwa.instance': instanceId },
  };
}

export interface InstanceSpecInput {
  readonly lab: LabEntry;
  readonly level: Level;
  readonly instanceId: string;
  /** Absent at Divine. */
  readonly flag?: string;
  readonly userId: number;
  readonly expiresAt: number;
}

export function containerSpec(input: InstanceSpecInput, settings: TemplateSettings): { name: string; body: Record<string, unknown> } {
  const { lab, level, instanceId, flag, userId, expiresAt } = input;
  const name = instanceResourceName(instanceId);
  const host = `i-${instanceId}.${settings.domain}`;
  const memory = Math.min(lab.resources.memoryMiB ?? LAB_LIMITS.memoryMiB, LAB_LIMITS.memoryMiB) * MIB;
  const pids = Math.min(lab.resources.pids ?? LAB_LIMITS.pids, LAB_LIMITS.pids);
  const nanoCpus = Math.round(Math.min(lab.resources.cpus ?? LAB_LIMITS.cpus, LAB_LIMITS.cpus) * 1e9);
  const router = `i-${instanceId}`;
  const gate = `g-${instanceId}`;
  return {
    name,
    body: {
      Image: lab.image,
      User: LAB_USER,
      // The flag only below Divine; the lab's start hook plants it and removes it from its environment (spec §6).
      Env: [`HVWA_LEVEL=${level}`, `HVWA_PORT=${lab.port}`, `HVWA_INSTANCE_HOST=${host}`, 'HOME=/tmp',
        ...(flag === undefined ? [] : [`HVWA_FLAG=${flag}`])],
      Labels: {
        [RANGE_LABEL]: '1', 'hvwa.instance': instanceId, 'hvwa.user': String(userId), 'hvwa.lab': lab.id, 'hvwa.level': level,
        'hvwa.expires': String(expiresAt),
        'traefik.enable': 'true',
        'traefik.docker.network': name,
        // The lab, behind forward-auth (docker/range/traefik/range.yml: hvwa-instance = secret header + forwardAuth + strip).
        [`traefik.http.routers.${router}.rule`]: `Host(\`${host}\`)`,
        [`traefik.http.routers.${router}.priority`]: '10',
        [`traefik.http.routers.${router}.middlewares`]: 'hvwa-instance@file',
        [`traefik.http.routers.${router}.service`]: router,
        [`traefik.http.services.${router}.loadbalancer.server.port`]: String(lab.port),
        // /__hvwa/* on this host goes to the portal (the gate-ticket exchange), WITHOUT forward-auth, ahead of the lab.
        [`traefik.http.routers.${gate}.rule`]: `Host(\`${host}\`) && PathPrefix(\`/__hvwa/\`)`,
        [`traefik.http.routers.${gate}.priority`]: '1000',
        [`traefik.http.routers.${gate}.service`]: 'hvwa-portal@file',
      },
      // Test [] = the image's own HEALTHCHECK (it requests the manifest's health path); the timings are ours (plan D2).
      Healthcheck: { Test: [], Interval: 2_000_000_000, Timeout: 2_000_000_000, Retries: 3, StartPeriod: 60_000_000_000, StartInterval: 500_000_000 },
      StopTimeout: 2,
      HostConfig: {
        ReadonlyRootfs: true,
        Tmpfs: Object.fromEntries(lab.tmpfs.map((t) => [t.path, `rw,noexec,nosuid,nodev,size=${t.sizeMiB}m`])),
        CapDrop: ['ALL'],
        CapAdd: [],
        SecurityOpt: ['no-new-privileges:true'],
        Privileged: false,
        PidsLimit: pids,
        Memory: memory,
        MemorySwap: memory,
        NanoCpus: nanoCpus,
        NetworkMode: name,
        PortBindings: {},
        PublishAllPorts: false,
        Binds: [],
        Mounts: [],
        VolumesFrom: [],
        Devices: [],
        RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
        Runtime: settings.runtime,
        IpcMode: 'private',
        LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
      },
      NetworkingConfig: { EndpointsConfig: { [name]: {} } },
    },
  };
}
