// The SSTI worker transport (src/core/ssti/transport.ts): the real worker_thread answers exactly what the in-thread
// transport answers, stays healthy after every bound, and its lifecycle is bounded: one worker, a bounded queue with
// an immediate 'busy' refusal, a watchdog for what the interrupt handler cannot stop, a fresh worker after any death,
// nothing left behind, and an idle worker never keeps the process up.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  SSTI_LIMITS, closeSandbox, inThreadTransport, renderInSandbox, setSandboxTransport, toJob, workerTransport,
  type SandboxInput, type SandboxTransport, type SstiResult, type WorkerTransport,
} from '../src/core/ssti/sandbox.js';
import type { SandboxJob } from '../src/core/ssti/engine.js';

const FIXTURES = new URL('./fixtures/ssti/', import.meta.url);
const fixture = (name: string) => new URL(name, FIXTURES);
const FLAG = 'HVWA{worker-flag}';
const NODE = { files: { '/srv/forum/flag': `${FLAG}\n` }, env: { FLAG: 'HVWA{worker-env}' } } as const;
const js = (body: string) => `{{ range.constructor("${body}")() }}`;
const LONG = SSTI_LIMITS.maxTimeoutMs;

/** A validated job (renderInSandbox's own checks), for calling a transport directly. */
function job(input: SandboxInput): SandboxJob {
  const j = toJob(input);
  if (!('template' in j)) throw new Error('job: refused before the transport');
  return j;
}

// Every transport a case opens is closed after it, whatever happened.
const opened: SandboxTransport[] = [];
const open = <T extends SandboxTransport>(t: T): T => {
  opened.push(t);
  return t;
};
afterEach(async () => {
  await Promise.all(opened.splice(0).map((t) => t.close()));
});
afterAll(async () => {
  await closeSandbox();
});

const ok42 = { ok: true, output: '42', shellCalls: [] };
const crashed = { ok: false, limit: 'crashed', shellCalls: [] };

describe('both transports agree', () => {
  const CASES: readonly SandboxInput[] = [
    { template: 'Hi {{ user.name }}, {{ 7 * 7 }}', ctx: { user: { name: 'pilgrim' } } },
    { template: '{{ name }}', ctx: { name: '<i>x</i>' } },
    { template: '{{ name }}', ctx: { name: '<i>x</i>' }, autoescape: false },
    { template: '{{ foo( }}' },
    { template: '{% include "/etc/passwd" %}' },
    { template: `{{ range.constructor("return global.process.mainModule.require('child_process').execSync('cat /srv/forum/flag')")() }}`, node: NODE },
    { template: '{{ cycler.constructor("return process.env.FLAG")() }}', node: NODE },
    { template: `{{ joiner.constructor("return process.mainModule.require('child_process').execSync('id; ls /srv; cat /nope')")() }}`, node: NODE },
    { template: `{{ range.constructor("return process.mainModule.require('child_process').execSync('cat /srv/forum/flag')")() }}` },
    { template: js("return [typeof process, typeof require, typeof fetch, typeof WebAssembly].join()") },
    { template: js('while (true) {}'), timeoutMs: 100 },
    { template: '{% for i in range(0, 100000) %}{% for j in range(0, 100000) %}{% endfor %}{% endfor %}', timeoutMs: 100 },
    { template: js('var a = []; while (true) a.push(new ArrayBuffer(1 << 20))'), timeoutMs: LONG },
    { template: js("var a = []; while (true) a.push({ i: a.length })"), timeoutMs: LONG },
    { template: js('(function f() { f() })()') },
    { template: '{% macro m(n) %}{{ m(n + 1) }}{% endmacro %}{{ m(0) }}' },
    { template: '{% for i in range(0, 2000) %}0123456789{% endfor %}' },
    // Not here: JSON.stringify over a deep value. It runs ~0.2 s with no interrupt check, then the worker reaches
    // QuickJS's stack limit while this thread (a 1 MB native stack) overflows natively first: both 'stack', unless a
    // loaded machine lets the worker's deadline pass first. Each side is checked on its own (ssti.spec.ts, the
    // watchdog case below).
  ];

  it('the worker and the in-thread transport give the same result for every case', async () => {
    const worker = open(workerTransport());
    const inThread = open(inThreadTransport());
    for (const input of CASES) {
      const w = await worker.render(job(input));
      const t = await inThread.render(job(input));
      expect(w, input.template).toEqual(t);
    }
    expect((await worker.stats()).dropped).toBe(0);
  });
});

describe('one long-lived worker, healthy after every bound', () => {
  it('a timeout, an allocation bomb, a stack overflow, an output overflow and an error leave the SAME worker serving', async () => {
    const t = open(workerTransport());
    expect(await t.render(job({ template: '{{ 6 * 7 }}' }))).toEqual(ok42);
    const { threadId } = await t.stats();
    expect(threadId).toBeTypeOf('number');
    for (const [input, limit] of [
      [{ template: js('for (;;) {}'), timeoutMs: 100 }, 'timeout'],
      [{ template: js('var a = []; while (true) a.push(new ArrayBuffer(1 << 20))'), timeoutMs: LONG }, 'memory'],
      [{ template: js('(function f() { f() })()') }, 'stack'],
      [{ template: '{% for i in range(0, 2000) %}0123456789{% endfor %}' }, 'output'],
      [{ template: '{{ nope( }}' }, undefined],
    ] as const) {
      const r = await t.render(job(input));
      expect(r.ok, input.template).toBe(false);
      expect(r.limit, input.template).toBe(limit);
      expect(await t.render(job({ template: '{{ 6 * 7 }}' })), `after ${input.template}`).toEqual(ok42);
    }
    const s = await t.stats();
    expect([s.threadId, s.started, s.dropped]).toEqual([threadId, 1, 0]);
    expect(s.worker?.renders).toBe(11);
  });

  it('the worker gets no environment and no flags from the host process, and its own V8 limits', async () => {
    // A stand-in worker reports what it was started with (FLAG_SECRET, a dev loader or --expose-gc never reach it).
    const t = open(workerTransport({ workerUrl: fixture('report-options.mjs') }));
    const r = await t.render(job({ template: 'x' }));
    expect(JSON.parse(r.output ?? 'null')).toEqual({
      env: [], execArgv: [], workerData: { hvwaSsti: 'hvwa-ssti/1' },
      resourceLimits: { ...SSTI_LIMITS.worker },
    });
    // And the sandbox's fake process.env shows only what the lab planted, over the fake machine's defaults.
    const real = open(workerTransport());
    const env = await real.render(job({ template: js("return Object.keys(process.env).sort().join(',')"), node: { env: { ONLY: 'this' } } }));
    expect(env.output).toBe('HOME,NODE_ENV,ONLY,PATH,PWD,USER');
  });
});

describe('the watchdog: what the interrupt handler cannot stop', () => {
  it('a native operation that overruns the watchdog gets its worker terminated; the next render gets a fresh one', async () => {
    // A 60 ms watchdog for the one uninterruptible job only (about 0.2 s inside JSON.stringify's cycle check, where
    // QuickJS never polls the interrupt handler); the ordinary renders around it keep a generous one, so a loaded
    // machine cannot turn them into timeouts.
    const deep = js('var a = []; for (var i = 0; i < 200000; i++) a = [a]; return JSON.stringify(a).length');
    const t = open(workerTransport({ watchdogMs: (j) => (j.template === deep ? 60 : 10_000) }));
    expect(await t.render(job({ template: '{{ 1 }}' }))).toMatchObject({ ok: true, output: '1' });
    const first = (await t.stats()).threadId;
    const r = await t.render(job({ template: deep }));
    expect(r).toEqual({ ok: false, limit: 'timeout', error: `The template took too long to render (over ${SSTI_LIMITS.defaultTimeoutMs} ms).`, shellCalls: [] });
    expect(await t.render(job({ template: '{{ 6 * 7 }}' }))).toEqual(ok42);
    const s = await t.stats();
    expect([s.started, s.dropped]).toEqual([2, 1]);
    expect(s.threadId).not.toBe(first);
  });

  it('a wedged worker (a spinning render) is terminated and replaced', async () => {
    const t = open(workerTransport({ workerUrl: fixture('hang.mjs'), watchdogMs: () => 100 }));
    const t0 = performance.now();
    expect(await t.render(job({ template: 'x' }))).toMatchObject({ ok: false, limit: 'timeout' });
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(await t.render(job({ template: 'x' }))).toMatchObject({ ok: false, limit: 'timeout' });
    const s = await t.stats();
    expect([s.started, s.dropped]).toEqual([2, 2]);
  });

  it('repeated restarts leave nothing behind: every dropped worker exits, and no timer is left running', async () => {
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const t = open(workerTransport({ workerUrl: fixture('hang.mjs'), watchdogMs: () => 50 }));
    for (let i = 0; i < 5; i++) expect(await t.render(job({ template: 'x' }))).toMatchObject({ limit: 'timeout' });
    await t.close();
    const s = await t.stats();
    expect([s.started, s.dropped, s.exiting, s.threadId, s.inFlight, s.queued]).toEqual([5, 5, 0, undefined, false, 0]);
    expect(process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length).toBeLessThanOrEqual(before);
  });
});

describe('a worker that dies, never starts or answers nonsense is dropped, and never loops', () => {
  for (const [name, opts] of [
    ['exits during a render', { workerUrl: fixture('exit-on-render.mjs') }],
    ['reports that it could not load (fatal)', { workerUrl: fixture('fatal.mjs') }],
    ['throws while loading', { workerUrl: fixture('throw-on-load.mjs') }],
    ['never gets ready', { workerUrl: fixture('never-ready.mjs'), spawnTimeoutMs: 200 }],
    ['answers past the output cap', { workerUrl: fixture('garbage.mjs') }],
    ['is not there at all', { workerUrl: fixture('no-such-worker.mjs') }],
  ] as const) {
    it(`a worker that ${name}: each render is 'crashed', one worker each, and nothing is left running`, async () => {
      const t = open(workerTransport(opts));
      const results = await Promise.all([1, 2, 3].map(() => t.render(job({ template: 'x' }))));
      for (const r of results) expect(r).toMatchObject(crashed);
      await t.close();
      const s = await t.stats();
      expect([s.started, s.dropped, s.exiting]).toEqual([3, 3, 0]);
    });
  }
});

describe('the queue: one in flight, a bounded wait, then an immediate 503-style refusal', () => {
  const busy: SstiResult = { ok: false, limit: 'busy', error: 'The template sandbox is busy; try again in a moment.', shellCalls: [] };

  it(`at most SSTI_LIMITS.queue (${SSTI_LIMITS.queue}) renders wait behind the one in flight; the next is refused at once`, async () => {
    const t = open(workerTransport());
    const loop = job({ template: js('for (;;) {}'), timeoutMs: 50 });
    const all = Array.from({ length: SSTI_LIMITS.queue + 3 }, () => t.render(loop));
    const settled: SstiResult[] = [];
    // The refusals answer before any render has run (the first is still waiting for the worker to start).
    const refused = await Promise.race([Promise.all(all.slice(SSTI_LIMITS.queue + 1)), new Promise<'late'>((r) => setTimeout(() => r('late'), 40))]);
    expect(refused).toEqual([busy, busy]);
    for (const r of await Promise.all(all)) settled.push(r);
    expect(settled.filter((r) => r.limit === 'timeout')).toHaveLength(SSTI_LIMITS.queue + 1);
    expect(settled.filter((r) => r.limit === 'busy')).toHaveLength(2);
    expect(await t.render(job({ template: '{{ 6 * 7 }}' }))).toEqual(ok42);
    expect((await t.stats()).started).toBe(1);
  });

  it('a smaller queue (a test seam) is honoured, and a larger one refused', async () => {
    const t = open(workerTransport({ queue: 0 }));
    const [a, b] = [t.render(job({ template: '{{ 6 * 7 }}' })), t.render(job({ template: '{{ 6 * 7 }}' }))];
    expect(await b).toEqual(busy);
    expect(await a).toEqual(ok42);
    expect(() => workerTransport({ queue: SSTI_LIMITS.queue + 1 })).toThrow(RangeError);
    expect(() => workerTransport({ queue: -1 })).toThrow(RangeError);
  });
});

describe('shutdown', () => {
  it('close() answers what is in flight and waiting ("stopped"), terminates the worker and refuses later renders', async () => {
    const t: WorkerTransport = open(workerTransport());
    expect(await t.render(job({ template: '{{ 6 * 7 }}' }))).toEqual(ok42);
    const pending = [t.render(job({ template: js('for (;;) {}'), timeoutMs: 1000 })), t.render(job({ template: '{{ 1 }}' }))];
    await new Promise((r) => setTimeout(r, 30));
    await t.close();
    const stopped = { ok: false, limit: 'crashed', error: 'The template sandbox was stopped.', shellCalls: [] };
    expect(await Promise.all(pending)).toEqual([stopped, stopped]);
    expect(await t.render(job({ template: '{{ 1 }}' }))).toEqual(stopped);
    const s = await t.stats();
    expect([s.threadId, s.exiting, s.inFlight, s.queued]).toEqual([undefined, 0, false, 0]);
    await t.close(); // twice is fine
  });

  it('renderInSandbox uses one default worker; closeSandbox() stops it and the next render starts a fresh one', async () => {
    const prev = setSandboxTransport(undefined);
    try {
      expect(await renderInSandbox({ template: '{{ 6 * 7 }}' })).toEqual(ok42);
      expect(await renderInSandbox({ template: '{{ 7 * 6 }}' })).toEqual(ok42);
      await closeSandbox();
      expect(await renderInSandbox({ template: '{{ 6 * 7 }}' })).toEqual(ok42);
      await closeSandbox();
    } finally {
      setSandboxTransport(prev);
    }
  });

  it('an idle worker never keeps the process up, a pending answer does: a process that rendered exits by itself', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const r = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(fixture('render-once.ts'))], {
      cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(r.error).toBeUndefined(); // a timeout would mean the worker kept the process alive
    expect([r.status, r.stdout]).toEqual([0, '42 1']); // exit 13 would be a stats reply the process did not wait for
  });
});

describe('cost (loose bounds; RECIPES section 14 has the measured numbers)', () => {
  it('a cold worker answers its first render within seconds, and a warm render takes milliseconds', async () => {
    const t = open(workerTransport());
    let t0 = performance.now();
    expect(await t.render(job({ template: '{{ 6 * 7 }}' }))).toEqual(ok42);
    const cold = performance.now() - t0;
    t0 = performance.now();
    for (let i = 0; i < 10; i++) await t.render(job({ template: 'Hi {{ name }}', ctx: { name: 'pilgrim' } }));
    const warm = (performance.now() - t0) / 10;
    expect(cold).toBeLessThan(10_000);
    expect(warm).toBeLessThan(SSTI_LIMITS.defaultTimeoutMs);
    const s = await t.stats();
    expect(s.heapUsed).toBeLessThan(SSTI_LIMITS.worker.maxOldGenerationSizeMb * 1024 * 1024);
  });
});
