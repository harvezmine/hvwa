// tests/support/fake-warden.ts — an in-process WardenApi for portal specs: "containers" in a map, health as the spec
// sets it, a failing next launch, a warden that is down, a crashed instance, an orphan container.
import { WardenError, type InstanceHealth, type LaunchRequest, type ListedInstance, type WardenApi, type WardenErrorCode } from '../../src/warden/protocol.js';

interface Box { readonly req: LaunchRequest; health: InstanceHealth; state: 'running' | 'exited' }

export interface FakeWarden extends WardenApi {
  readonly launched: LaunchRequest[];
  readonly stopped: string[];
  readonly boxes: Map<string, Box>;
  /** Every call throws WardenError('unavailable') while true. */
  down: boolean;
  setHealth(instanceId: string, health: InstanceHealth): void;
  failNextLaunch(code: WardenErrorCode): void;
  /** A container no record owns (left over from a crash, or made by hand). */
  addOrphan(instanceId: string): void;
  /** The container exited (restart policy none): still listed, health failed. */
  crash(instanceId: string): void;
}

export function fakeWarden(opts: { autoReady?: boolean } = {}): FakeWarden {
  const launched: LaunchRequest[] = [];
  const stopped: string[] = [];
  const boxes = new Map<string, Box>();
  let failNext: WardenErrorCode | undefined;
  const guard = () => { if (w.down) throw new WardenError('unavailable', 0); };
  const w: FakeWarden = {
    launched, stopped, boxes, down: false,
    setHealth(id, health) { const b = boxes.get(id); if (b) b.health = health; },
    failNextLaunch(code) { failNext = code; },
    addOrphan(id) {
      boxes.set(id, { req: { labId: 'r01', level: 'acolyte', instanceId: id, flag: `HVWA{${'a'.repeat(26)}}`, userId: 999, expiresAt: 1 },
        health: { status: 'ready' }, state: 'running' });
    },
    crash(id) { const b = boxes.get(id); if (b) { b.state = 'exited'; b.health = { status: 'failed', reason: 'exited' }; } },
    async launch(req) {
      guard();
      if (failNext) { const code = failNext; failNext = undefined; throw new WardenError(code, code === 'docker' ? 502 : 400); }
      if (boxes.has(req.instanceId)) throw new WardenError('exists', 409);
      launched.push(req);
      boxes.set(req.instanceId, { req, health: { status: opts.autoReady ? 'ready' : 'starting' }, state: 'running' });
    },
    async stop(id) { guard(); stopped.push(id); boxes.delete(id); },
    async list(): Promise<ListedInstance[]> {
      guard();
      return [...boxes.values()].map((b) => ({
        instanceId: b.req.instanceId, labId: b.req.labId, level: b.req.level, userId: b.req.userId, expiresAt: b.req.expiresAt, state: b.state,
      }));
    },
    async health(id) { guard(); return boxes.get(id)?.health ?? { status: 'missing' }; },
  };
  return w;
}
