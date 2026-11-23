// src/warden/warden.ts — the warden's operations (spec range §3, §5.2): the only code that creates or removes lab
// containers. The image allowlist is the registry: a lab id selects its digest-pinned image; anything else is refused
// before Docker is touched. A failed launch leaves nothing behind.
import { INSTANCE_ID_RE } from '../range/ids.js';
import type { LabRegistry } from '../lab-registry.js';
import { DockerError, type ContainerInspect, type ContainerSummary, type DockerClient } from './docker.js';
import { launchRequestSchema, WardenError, type InstanceHealth, type LaunchRequest, type ListedInstance, type WardenApi } from './protocol.js';
import {
  containerSpec, INSTANCE_SUBNET_FIRST, INSTANCE_SUBNET_LAST, instanceResourceName, networkSpec, RANGE_LABEL, type TemplateSettings,
} from './template.js';

export interface WardenSettings extends TemplateSettings {
  /** The Traefik container the warden connects to every instance network (compose: container_name). */
  readonly traefikContainer: string;
}

export interface WardenDeps {
  readonly docker: DockerClient;
  readonly registry: LabRegistry;
  readonly settings: WardenSettings;
  /** One line per launch / stop (never a flag). Default: silent. */
  readonly log?: (line: string) => void;
}

export function createWarden(deps: WardenDeps): WardenApi {
  const { docker, registry, settings } = deps;
  const log = deps.log ?? (() => {});

  /**
   * Create the instance network on the first free /24 of the pool. Two launches (or another stack on this engine) can
   * race for the same bucket, so an overlap advances to the next one; a network name that already exists is a real
   * error and is not retried.
   */
  async function createInstanceNetwork(instanceId: string): Promise<void> {
    const tries = INSTANCE_SUBNET_LAST - INSTANCE_SUBNET_FIRST + 1;
    for (let attempt = 0; attempt < tries; attempt += 1) {
      try {
        await docker.createNetwork(networkSpec(instanceId, attempt));
        return;
      } catch (err) {
        if (!(err instanceof DockerError)) throw err;
        if (err.status === 409 && /already exists/i.test(err.message)) throw err;
        if (!/overlap|address space|pool/i.test(err.message)) throw err;
      }
    }
    throw new DockerError(409, '/networks/create', 'no free instance subnet');
  }

  /** Container, then Traefik's endpoint, then the network (Docker refuses to remove a network with endpoints). */
  async function cleanup(instanceId: string): Promise<void> {
    const name = instanceResourceName(instanceId);
    await docker.removeContainer(name);
    try { await docker.disconnectNetwork(name, settings.traefikContainer); } catch (err) { if (!(err instanceof DockerError)) throw err; }
    await docker.removeNetwork(name);
  }

  // One launch or stop at a time per instance id. Without it, a second launch of the same id (a retry) passes the
  // "exists" check while the first is still creating, fails on the network, and its cleanup removes the first's
  // container and network: both launches fail. A stop sent during a launch likewise waits for it.
  const queues = new Map<string, Promise<void>>();
  function serial<T>(instanceId: string, op: () => Promise<T>): Promise<T> {
    const run = (queues.get(instanceId) ?? Promise.resolve()).then(op);
    const settled = run.then(() => {}, () => {});
    queues.set(instanceId, settled);
    void settled.then(() => { if (queues.get(instanceId) === settled) queues.delete(instanceId); });
    return run;
  }

  return Object.freeze({
    async launch(raw: LaunchRequest): Promise<void> {
      const parsed = launchRequestSchema.safeParse(raw);
      if (!parsed.success) throw new WardenError('bad_request', 400);
      const r = parsed.data;
      const lab = registry.get(r.labId);
      if (!lab) throw new WardenError('unknown_lab', 404);
      if (!lab.levels.includes(r.level)) throw new WardenError('bad_level', 400);
      const name = instanceResourceName(r.instanceId);
      await serial(r.instanceId, async () => {
        try {
          if (await docker.inspectContainer(name)) throw new WardenError('exists', 409);
          const spec = containerSpec({ lab, level: r.level, instanceId: r.instanceId, userId: r.userId, expiresAt: r.expiresAt }, settings);
          await createInstanceNetwork(r.instanceId);
          await docker.createContainer(spec.name, spec.body);
          await docker.connectNetwork(name, settings.traefikContainer);
          await docker.startContainer(name);
          // Deliver the flag only below Divine (spec §6): after start, as a one-shot file in the tmpfs, never in the
          // environment, the image, the container config or `docker inspect`. A read-only rootfs means the Engine's
          // archive endpoint refuses writes, so the warden runs a tiny exec (uid 10001) that writes the flag to
          // HVWA_FLAG_FILE. The lab's start hook polls for it, reads it once and unlinks it. A failed delivery is a
          // failed launch: the catch below stops and removes the container, leaving nothing behind.
          if (r.flag !== undefined) {
            const execId = await docker.execCreate(name, {
              User: '10001:10001', AttachStdin: false, AttachStdout: false, AttachStderr: false, Tty: false,
              // The lab polls the final path and unlinks the file as soon as it appears. Write a temp name, chmod it,
              // then rename last, so the delivery can never fail because the lab removed the file mid-exec.
              Cmd: ['sh', '-c', 'umask 077; printf \'%s\\n\' "$1" > /tmp/.hvwa-flag.tmp; chmod 400 /tmp/.hvwa-flag.tmp; mv /tmp/.hvwa-flag.tmp /tmp/.hvwa-flag', 'sh', r.flag],
            });
            await docker.execStart(execId);
          }
          log(`warden: launched ${r.instanceId} ${r.labId}/${r.level} for user ${r.userId}`);
        } catch (err) {
          if (err instanceof WardenError) throw err;
          await cleanup(r.instanceId).catch(() => { /* the portal's reaper removes leftovers */ });
          log(`warden: launch of ${r.instanceId} failed: ${err instanceof Error ? err.message : String(err)}`);
          throw new WardenError('docker', 502);
        }
      });
    },

    async stop(instanceId: string): Promise<void> {
      if (!INSTANCE_ID_RE.test(instanceId)) throw new WardenError('bad_request', 400);
      await serial(instanceId, async () => {
        try {
          await cleanup(instanceId);
        } catch (err) {
          if (err instanceof DockerError) throw new WardenError('docker', 502);
          throw err;
        }
      });
      log(`warden: stopped ${instanceId}`);
    },

    async list(): Promise<ListedInstance[]> {
      let found: ContainerSummary[];
      try { found = await docker.listContainers(`${RANGE_LABEL}=1`); } catch { throw new WardenError('docker', 502); }
      return found.flatMap((c) => {
        const l = c.Labels ?? {};
        const instanceId = l['hvwa.instance'] ?? '';
        if (!INSTANCE_ID_RE.test(instanceId)) return [];
        return [{
          instanceId, labId: String(l['hvwa.lab'] ?? '').slice(0, 10), level: String(l['hvwa.level'] ?? '').slice(0, 20),
          userId: Number.parseInt(l['hvwa.user'] ?? '0', 10) || 0, expiresAt: Number.parseInt(l['hvwa.expires'] ?? '0', 10) || 0,
          state: String(c.State).slice(0, 20),
        }];
      });
    },

    async health(instanceId: string): Promise<InstanceHealth> {
      if (!INSTANCE_ID_RE.test(instanceId)) throw new WardenError('bad_request', 400);
      let c: ContainerInspect | undefined;
      try { c = await docker.inspectContainer(instanceResourceName(instanceId)); } catch { throw new WardenError('docker', 502); }
      if (!c) return { status: 'missing' };
      const s = c.State;
      if (s.Status === 'running') {
        const h = s.Health?.Status;
        if (h === 'healthy') return { status: 'ready' };
        if (h === 'starting') return { status: 'starting' };
        if (h === 'unhealthy') return { status: 'failed', reason: 'unhealthy' };
        return { status: 'failed', reason: 'no_healthcheck' }; // the image declares no HEALTHCHECK (plan D2)
      }
      if (s.Status === 'created' || s.Status === 'restarting') return { status: 'starting' };
      return { status: 'failed', reason: s.OOMKilled ? 'oom' : 'exited' };
    },
  });
}
