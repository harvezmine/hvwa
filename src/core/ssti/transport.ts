// src/core/ssti/transport.ts — how a render reaches the engine. Both transports run engine.ts's renderJob on the
// same job, so they answer the same (tests/ssti-worker.spec.ts checks it):
//
// - workerTransport(): production. ONE long-lived worker_thread (the container has pids_limit 256 and 512 MB; a
//   render takes about 15 ms, so one worker serves about 60 renders a second), started by the first render. Renders
//   run one at a time; at most SSTI_LIMITS.queue wait behind the one in flight, and the next is refused at once
//   (`limit: 'busy'`; a lab answers 503). A watchdog in two phases terminates a worker whose render overruns: the
//   boot (bootWatchdogMs, until the worker reports that the player's code started), then timeoutMs + watchdogSlackMs
//   (a native operation the interrupt handler cannot stop). A worker that dies, never gets ready or answers in a
//   shape this protocol does not have is dropped too. The next render starts a fresh one. An idle worker is unref'd,
//   so it never keeps the process up.
// - inThreadTransport(): tests. The same engine on the calling thread: no worker and no watchdog (a native operation
//   blocks the caller), so never in production.
import { Worker } from 'node:worker_threads';
import {
  SSTI_LIMITS, SSTI_MESSAGES, WORKER_TAG, clipText, loadAssets, renderJob, warmUp,
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
/** How long stats() waits for the worker's counters (they queue behind a render in flight). */
const STATS_TIMEOUT_MS = 5000;
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
  /** The boot-phase watchdog, in ms, until the worker reports 'started' (default SSTI_LIMITS.bootWatchdogMs). */
  readonly bootWatchdogMs?: number;
  /** The render-phase watchdog for one render, in ms, from 'started' (default timeoutMs + watchdogSlackMs). */
  readonly watchdogMs?: (job: SandboxJob) => number;
  /** How long a new worker may take to get ready, in ms (default SSTI_LIMITS.spawnTimeoutMs). */
  readonly spawnTimeoutMs?: number;
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
  const bootWatchdogMs = opts.bootWatchdogMs ?? SSTI_LIMITS.bootWatchdogMs;
  const watchdogMs = opts.watchdogMs ?? ((job: SandboxJob) => job.timeoutMs + SSTI_LIMITS.watchdogSlackMs);
  const spawnTimeoutMs = opts.spawnTimeoutMs ?? SSTI_LIMITS.spawnTimeoutMs;
  const url = opts.workerUrl ?? ENGINE_URL;
  const queue: Pending[] = [];
  const exiting = new Set<Promise<void>>();
  let live: Live | undefined;
  /** The render on the worker: its watchdog timer, and whether the worker reported that the player's code started. */
  let inFlight: { readonly p: Pending; timer: NodeJS.Timeout; started: boolean } | undefined;
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
    } else if (m?.type === 'started' && inFlight !== undefined && m.id === inFlight.p.id && !inFlight.started) {
      // The boot is done: from now on the render-phase watchdog (the player's deadline plus slack) applies.
      const f = inFlight;
      clearTimeout(f.timer);
      f.started = true;
      f.timer = setTimeout(() => {
        if (inFlight !== f) return;
        drop(l); // the interrupt handler did not stop it: a native call that never polls, or a wedged instance
        finish(refusal('timeout', SSTI_MESSAGES.timeout(f.p.job.timeoutMs)));
      }, watchdogMs(f.p.job)).unref();
    } else if (m?.type === 'result' && inFlight !== undefined && m.id === inFlight.p.id) {
      const r = checked(m.result);
      if (r === undefined) lost(l);
      else finish(r);
    } else if (m?.type === 'stats' && l.statsWaiters.has(m.id)) {
      const reply = l.statsWaiters.get(m.id);
      l.statsWaiters.delete(m.id);
      reply?.(m.stats);
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
      spawnTimer: setTimeout(() => lost(l), spawnTimeoutMs).unref(),
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
      // The boot-phase watchdog: the engine's own work, before the player's code (a wedged boot is a crash).
      const timer = setTimeout(() => {
        if (inFlight?.p !== p) return;
        drop(l);
        finish(refusal('crashed', CRASHED));
      }, bootWatchdogMs).unref();
      inFlight = { p, timer, started: false };
      l.worker.postMessage({ type: 'render', id: p.id, job: p.job } satisfies ToWorker);
      return;
    }
    idle();
  };

  /** Nothing waits on the live worker (no render, no stats reply): it may no longer keep the process up. */
  const idle = (): void => {
    if (live !== undefined && inFlight === undefined && queue.length === 0 && live.statsWaiters.size === 0) live.worker.unref();
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
        l.worker.ref(); // a reply is awaited: keep the process up until it comes
        // A worker that never answers (not our engine) gets no stats, rather than a caller waiting forever.
        const giveUp = setTimeout(() => {
          l.statsWaiters.get(id)?.(undefined);
          l.statsWaiters.delete(id);
        }, STATS_TIMEOUT_MS);
        worker = await new Promise<WorkerStats | undefined>((resolve) => {
          l.statsWaiters.set(id, resolve);
          l.worker.postMessage({ type: 'stats', id } satisfies ToWorker);
        });
        clearTimeout(giveUp);
        if (worker !== undefined) heapUsed = await l.worker.getHeapStatistics().then((h) => h.used_heap_size, () => undefined);
        idle();
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

/**
 * A worker's answer, checked again before a lab sees it. A malformed SHAPE means the worker is not running our
 * engine any more: undefined, and the worker goes. A SIZE past a cap is data a template may push on (lone surrogates
 * once grew a string threefold on its way out), so it is bounded here instead and the worker stays: an output over the
 * cap is refused (`limit: 'output'`), an error and the commands are clipped.
 */
function checked(r: unknown): SstiResult | undefined {
  if (r === null || typeof r !== 'object') return undefined;
  const { ok, output, error, limit, shellCalls } = r as Record<string, unknown>;
  if (typeof ok !== 'boolean' || !Array.isArray(shellCalls) || !shellCalls.every((c) => typeof c === 'string')) return undefined;
  const calls = (shellCalls as string[]).slice(0, SSTI_LIMITS.shellCallsKept).map((c) => clipText(c, SSTI_LIMITS.shellCallChars));
  if (ok) {
    if (typeof output !== 'string' || error !== undefined || limit !== undefined) return undefined;
    if (output.length > SSTI_LIMITS.outputChars) return { ok: false, error: SSTI_MESSAGES.output, limit: 'output', shellCalls: calls };
    return { ok, output, shellCalls: calls };
  }
  if (typeof error !== 'string' || output !== undefined) return undefined;
  if (limit !== undefined && (typeof limit !== 'string' || !LIMITS.has(limit))) return undefined;
  const clipped = clipText(error, SSTI_LIMITS.errorChars);
  return limit === undefined ? { ok, error: clipped, shellCalls: calls } : { ok, error: clipped, limit: limit as SstiLimit, shellCalls: calls };
}
