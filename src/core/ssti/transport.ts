// src/core/ssti/transport.ts — how a render reaches the engine. Both transports run engine.ts's renderJob on the
// same job, so they answer the same (tests/ssti-worker.spec.ts checks it):
//
// - workerTransport(): production. ONE long-lived worker_thread (the container has pids_limit 256 and 512 MB; a
//   render takes about 15 ms, so one worker serves about 60 renders a second), started by the first render. Renders
//   run one at a time; at most SSTI_LIMITS.queue wait behind the one in flight, and the next is refused at once
//   (`limit: 'busy'`; a lab answers 503). A watchdog terminates a worker whose render overruns bootMs + timeoutMs +
//   watchdogSlackMs (a native operation the interrupt handler cannot stop); a worker that dies, never gets ready or
//   answers nonsense is dropped too. The next render starts a fresh one. An idle worker is unref'd, so it never
//   keeps the process up.
// - inThreadTransport(): tests. The same engine on the calling thread: no worker and no watchdog (a native operation
//   blocks the caller), so never in production.
import { Worker } from 'node:worker_threads';
import {
  SSTI_LIMITS, WORKER_TAG, loadAssets, renderJob, warmUp,
  type EngineAssets, type FromWorker, type SandboxJob, type SstiLimit, type SstiResult, type ToWorker, type WorkerStats,
} from './engine.js';

/** Where renders go (see renderInSandbox; tests swap it with setSandboxTransport). */
export interface SandboxTransport {
  /** Render one validated job. Never rejects: every bound, crash or refusal is an SstiResult. */
  render(job: SandboxJob): Promise<SstiResult>;
  /** Stop: renders still waiting, and any later one, answer `crashed` ("stopped"). Resolves once the worker exited. */
  close(): Promise<void>;
}

const STOPPED = 'The template sandbox was stopped.';
const BUSY = 'The template sandbox is busy; try again in a moment.';
const CRASHED = 'The template sandbox failed; it is restarted for the next render.';
const refusal = (limit: SstiLimit, error: string): SstiResult => ({ ok: false, error, limit, shellCalls: [] });

/** The engine on the calling thread (tests only: see the file comment). Loads the engine's files on first use. */
export function inThreadTransport(): SandboxTransport {
  let assets: Promise<EngineAssets> | undefined;
  let closed = false;
  const load = async (): Promise<EngineAssets> => {
    const a = loadAssets();
    await warmUp(a);
    return a;
  };
  return {
    async render(job) {
      if (closed) return refusal('crashed', STOPPED);
      assets ??= load();
      return renderJob(job, await assets);
    },
    async close() {
      closed = true;
    },
  };
}

/** What the worker transport did so far (tests, and the measurements in RECIPES section 14). */
export interface WorkerTransportStats {
  /** Workers started, and how many of them were dropped (watchdog, crash, never ready, a malformed answer, close). */
  readonly started: number;
  readonly dropped: number;
  /** The live worker's thread id (undefined: none started yet, or none since the last drop). */
  readonly threadId: number | undefined;
  readonly inFlight: boolean;
  readonly queued: number;
  /** Dropped workers whose exit has not been seen yet (0 once they are all gone: nothing is left behind). */
  readonly exiting: number;
  /** The live worker's own counters, and its V8 heap (undefined without a ready worker). */
  readonly worker: WorkerStats | undefined;
  readonly heapUsed: number | undefined;
}

export interface WorkerTransport extends SandboxTransport {
  stats(): Promise<WorkerTransportStats>;
}

/** Test seams of workerTransport. Production uses the defaults. */
export interface WorkerTransportOptions {
  /** Renders that may wait behind the one in flight (default and most: SSTI_LIMITS.queue). */
  readonly queue?: number;
  /** The watchdog for one render, in ms (default bootMs + timeoutMs + watchdogSlackMs). */
  readonly watchdogMs?: (job: SandboxJob) => number;
  /** The worker script (default: engine.ts from src/, engine.js from dist/). Tests pass misbehaving fixtures. */
  readonly workerUrl?: URL;
}

/** engine.ts as the worker entry: next to this file, with this file's own extension (.ts in src/, .js in dist/). */
export const ENGINE_URL = new URL(import.meta.url.endsWith('.ts') ? './engine.ts' : './engine.js', import.meta.url);

interface Pending {
  readonly id: number;
  readonly job: SandboxJob;
  readonly resolve: (r: SstiResult) => void;
}

interface Live {
  readonly worker: Worker;
  ready: boolean;
  readonly spawnTimer: NodeJS.Timeout;
  readonly statsWaiters: Map<number, (s: WorkerStats | undefined) => void>;
}

/** The production transport: one worker, a bounded queue, a watchdog, restart on demand (see the file comment). */
export function workerTransport(opts: WorkerTransportOptions = {}): WorkerTransport {
  const maxQueue = opts.queue ?? SSTI_LIMITS.queue;
  if (!Number.isInteger(maxQueue) || maxQueue < 0 || maxQueue > SSTI_LIMITS.queue) {
    throw new RangeError(`workerTransport: queue must be an integer from 0 to ${SSTI_LIMITS.queue} (got ${String(maxQueue)})`);
  }
  const watchdogMs = opts.watchdogMs ?? ((job: SandboxJob) => SSTI_LIMITS.bootMs + job.timeoutMs + SSTI_LIMITS.watchdogSlackMs);
  const url = opts.workerUrl ?? ENGINE_URL;
  const queue: Pending[] = [];
  const exiting = new Set<Promise<void>>();
  let live: Live | undefined;
  let inFlight: { readonly p: Pending; readonly timer: NodeJS.Timeout } | undefined;
  let nextId = 1;
  let started = 0;
  let dropped = 0;
  let closed = false;

  /** Terminate `l` and forget it; the next render starts a fresh worker. close() awaits its exit. */
  const drop = (l: Live): void => {
    if (live !== l) return;
    live = undefined;
    dropped += 1;
    clearTimeout(l.spawnTimer);
    for (const w of l.statsWaiters.values()) w(undefined);
    l.statsWaiters.clear();
    const gone: Promise<void> = l.worker.terminate().then(() => undefined, () => undefined).finally(() => {
      l.worker.removeAllListeners();
      exiting.delete(gone);
    });
    exiting.add(gone);
  };

  /** The render in flight ends with `r` (its answer, a watchdog timeout or a crash); the next one starts. */
  const finish = (r: SstiResult): void => {
    const f = inFlight;
    if (f === undefined) return;
    inFlight = undefined;
    clearTimeout(f.timer);
    f.p.resolve(r);
    pump();
  };

  /** `l` died, did not get ready, or answered nonsense: the render it held (in flight, or waiting for it) crashed. */
  const lost = (l: Live): void => {
    if (live !== l) return;
    const wasReady = l.ready;
    drop(l);
    if (inFlight !== undefined) return finish(refusal('crashed', CRASHED));
    if (!wasReady) queue.shift()?.resolve(refusal('crashed', CRASHED)); // so a worker that never starts cannot loop
    pump();
  };

  const onMessage = (l: Live, m: FromWorker): void => {
    if (live !== l) return;
    if (m?.type === 'ready' && !l.ready) {
      l.ready = true;
      clearTimeout(l.spawnTimer);
      pump();
    } else if (m?.type === 'result' && inFlight !== undefined && m.id === inFlight.p.id) {
      const r = checked(m.result);
      if (r === undefined) lost(l);
      else finish(r);
    } else if (m?.type === 'stats' && l.statsWaiters.has(m.id)) {
      l.statsWaiters.get(m.id)?.(m.stats);
      l.statsWaiters.delete(m.id);
    } else {
      lost(l); // 'fatal' (it could not load or warm up), or anything this protocol does not have
    }
  };

  const spawn = (): Live | undefined => {
    let worker: Worker;
    try {
      worker = new Worker(url, {
        name: 'hvwa-ssti',
        workerData: { hvwaSsti: WORKER_TAG },
        // Nothing inherited: no flags (a dev loader, --expose-gc) and no environment (FLAG_SECRET never reaches it).
        execArgv: [],
        env: {},
        resourceLimits: { ...SSTI_LIMITS.worker },
      });
    } catch {
      return undefined;
    }
    started += 1;
    worker.unref();
    const l: Live = {
      worker,
      ready: false,
      spawnTimer: setTimeout(() => lost(l), SSTI_LIMITS.spawnTimeoutMs).unref(),
      statsWaiters: new Map(),
    };
    worker.on('message', (m: FromWorker) => onMessage(l, m));
    worker.on('error', () => lost(l));
    worker.on('exit', () => lost(l));
    return l;
  };

  const pump = (): void => {
    while (!closed && inFlight === undefined && queue.length > 0) {
      if (live === undefined) {
        live = spawn();
        if (live === undefined) {
          queue.shift()?.resolve(refusal('crashed', CRASHED));
          continue;
        }
      }
      const l = live;
      l.worker.ref(); // work is waiting: keep the process up until it is answered
      if (!l.ready) return; // 'ready' pumps again
      const p = queue.shift() as Pending;
      const timer = setTimeout(() => {
        if (inFlight?.p !== p) return;
        drop(l); // the interrupt handler did not stop it: a native operation, or a wedged instance
        finish(refusal('timeout', `The template took too long to render (over ${p.job.timeoutMs} ms).`));
      }, watchdogMs(p.job)).unref();
      inFlight = { p, timer };
      l.worker.postMessage({ type: 'render', id: p.id, job: p.job } satisfies ToWorker);
      return;
    }
    if (live !== undefined && inFlight === undefined && queue.length === 0) live.worker.unref();
  };

  return {
    render(job) {
      if (closed) return Promise.resolve(refusal('crashed', STOPPED));
      // One in flight (or starting the worker) plus `maxQueue` waiting; the next is refused without waiting.
      if (queue.length + (inFlight === undefined ? 0 : 1) > maxQueue) return Promise.resolve(refusal('busy', BUSY));
      return new Promise<SstiResult>((resolve) => {
        queue.push({ id: nextId++, job, resolve });
        pump();
      });
    },
    async stats() {
      const l = live;
      let worker: WorkerStats | undefined;
      let heapUsed: number | undefined;
      if (l !== undefined && l.ready) {
        const id = nextId++;
        worker = await new Promise<WorkerStats | undefined>((resolve) => {
          l.statsWaiters.set(id, resolve);
          l.worker.postMessage({ type: 'stats', id } satisfies ToWorker);
        });
        heapUsed = await l.worker.getHeapStatistics().then((h) => h.used_heap_size, () => undefined);
      }
      return {
        started, dropped, threadId: live?.worker.threadId, inFlight: inFlight !== undefined, queued: queue.length,
        exiting: exiting.size, worker, heapUsed,
      };
    },
    async close() {
      closed = true;
      const f = inFlight;
      inFlight = undefined;
      if (f !== undefined) {
        clearTimeout(f.timer);
        f.p.resolve(refusal('crashed', STOPPED));
      }
      for (const p of queue.splice(0)) p.resolve(refusal('crashed', STOPPED));
      if (live !== undefined) drop(live);
      await Promise.all([...exiting]);
    },
  };
}

const LIMITS: ReadonlySet<string> = new Set<SstiLimit>(['input', 'timeout', 'memory', 'stack', 'output', 'busy', 'crashed']);
/** The engine's fixed messages may be a little longer than a clipped template error. */
const MAX_ERROR = SSTI_LIMITS.errorChars + 200;

/** A worker's answer, checked against the bounds again before a lab sees it (undefined: malformed, the worker goes). */
function checked(r: unknown): SstiResult | undefined {
  if (r === null || typeof r !== 'object') return undefined;
  const { ok, output, error, limit, shellCalls } = r as Record<string, unknown>;
  if (typeof ok !== 'boolean' || !Array.isArray(shellCalls) || shellCalls.length > SSTI_LIMITS.shellCallsKept) return undefined;
  if (!shellCalls.every((c) => typeof c === 'string' && c.length <= SSTI_LIMITS.shellCallChars + 32)) return undefined;
  const calls = shellCalls as string[];
  if (ok) {
    if (typeof output !== 'string' || output.length > SSTI_LIMITS.outputChars || error !== undefined || limit !== undefined) return undefined;
    return { ok, output, shellCalls: calls };
  }
  if (typeof error !== 'string' || error.length > MAX_ERROR || output !== undefined) return undefined;
  if (limit === undefined) return { ok, error, shellCalls: calls };
  if (typeof limit !== 'string' || !LIMITS.has(limit)) return undefined;
  return { ok, error, limit: limit as SstiLimit, shellCalls: calls };
}
