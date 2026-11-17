// src/core/ssti/engine.ts — where Nunjucks runs: ONE FRESH QuickJS-WASM instance per render, inside the SSTI worker
// thread (transport.ts, workerTransport) or on the calling thread (inThreadTransport, tests only). Owner decisions
// Q2/Q3/Q7: Nunjucks runs only inside QuickJS, there is no extra service, and "execution" is simulated: the template
// reaches a FAKE child_process whose shell (fakeShell, below) answers from data the lab planted. Nothing runs for real.
//
// THIS FILE IS THE WORKER ENTRY. It is loaded directly by `new Worker(...)`: as JavaScript from dist/, and from src/
// through Node's built-in type stripping (Node >= 22.18; tests and `npm run dev`). So it has NO relative imports
// (a `./x.js` specifier does not exist next to a .ts source), only erasable TypeScript, and `import type` for types.
//
// What crosses the boundary: the host hands the guest strings only (the template, the context as JSON, the fake
// process.env as JSON) and reads back primitive strings only, after checking their length on the guest's own value
// (a primitive string's length runs no guest code). The guest has exactly one host binding, and only when the lab
// asks for the simulated Node host: the fake shell's bridge, string in, JSON string out (see renderJob).
//
// Host side (the guard in tests/ssti-guard.spec.ts): node:fs is used for ONE thing, reading two fixed files once
// (the QuickJS .wasm and the Nunjucks browser bundle, resolved from their packages, never from input). A worker then
// seals itself: every fs, network, child-process and vm function in its own realm throws from then on.
import { readFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import type { QuickJSContext, QuickJSHandle, QuickJSSyncVariant } from 'quickjs-emscripten-core';
import * as releaseSyncPackage from '@jitl/quickjs-wasmfile-release-sync';

// Node loads the package's ESM entry, whose default export IS the variant; its types are CommonJS, where TypeScript
// sees the default as `{ default: variant }`. Take whichever this is, checked by its `type`.
const packageDefault: unknown = releaseSyncPackage.default;
const releaseSync = ((packageDefault as { type?: unknown }).type === 'sync'
  ? packageDefault : (packageDefault as { default: unknown }).default) as QuickJSSyncVariant;

/** Every bound of the SSTI sandbox. Measured numbers are in docs/RECIPES.md section 14. */
export const SSTI_LIMITS = Object.freeze({
  /** Longest template source, in UTF-16 code units (a longer one is refused before it crosses: `limit: 'input'`). */
  templateChars: 4096,
  /** Longest context, as its JSON text (refused before it crosses: `limit: 'input'`). */
  ctxChars: 16 * 1024,
  /** Longest output; a longer one is never copied out of the sandbox (`limit: 'output'`). */
  outputChars: 16 * 1024,
  /** Longest error message copied out (longer ones are clipped inside the sandbox's answer). */
  errorChars: 500,
  /** Default and largest render deadline (ms), enforced by QuickJS's interrupt handler. */
  defaultTimeoutMs: 250,
  maxTimeoutMs: 1000,
  /** Deadline for loading Nunjucks into the fresh context (ours, not the player's; about 15 ms warm). */
  bootMs: 500,
  /**
   * Three memory bounds, tightest first. (1) The interrupt handler stops a render once the instance's WASM memory
   * has grown past `memoryInterruptBytes`: it catches the many small allocations that would otherwise reach QuickJS's
   * limit with no room left for the error object (QuickJS then throws null, and Nunjucks reports a TypeError). (2)
   * QuickJS's own allocation limit (rt.setMemoryLimit) refuses one big allocation at once ("out of memory").
   * (3) The WebAssembly.Memory starts at 16 MiB (the module's minimum) and can never grow past `wasmMaxBytes`.
   */
  memoryInterruptBytes: 28 * 1024 * 1024,
  memoryBytes: 32 * 1024 * 1024,
  wasmInitialBytes: 16 * 1024 * 1024,
  wasmMaxBytes: 48 * 1024 * 1024,
  /**
   * QuickJS's stack limit (rt.setMaxStackSize): about 730 nested JS calls. QuickJS measures the WASM shadow stack;
   * the native frames behind it are 16 to 32 times larger in its C recursion (the parser, JSON), which this keeps
   * inside the worker's 8 MB stack, and JSON.stringify's quadratic cycle check over a deep value (no interrupt
   * checks) stays near 0.2 s. RECIPES section 14 has the measurements.
   */
  stackBytes: 128 * 1024,
  /** The fake shell: calls recorded in `shellCalls` (each clipped), calls answered per render, command length. */
  shellCallsKept: 16,
  shellCallChars: 200,
  shellCallsPerRender: 64,
  shellCommandChars: 1000,
  shellOutputChars: 16 * 1024,
  /** The simulated Node host a lab plants (FakeNode): files, file size, env vars, env value size, path length. */
  nodeFiles: 16,
  nodeFileChars: 4096,
  nodeEnvVars: 16,
  nodeEnvChars: 1024,
  nodePathChars: 255,
  /** The worker transport: renders waiting behind the one in flight (beyond: `limit: 'busy'`). */
  queue: 8,
  /**
   * The host's watchdog per render, in two phases, then the worker is terminated. Until the worker reports that the
   * player's code started: `bootWatchdogMs` (the boot is ours; a wedged one answers 'crashed'). From then on:
   * timeoutMs + `watchdogSlackMs` (a native call that never polls the interrupt handler answers 'timeout'). So one
   * render holds the worker at most about 0.5 s past its boot at the default deadline, plus a fresh worker's start.
   */
  bootWatchdogMs: 1000,
  watchdogSlackMs: 250,
  /** A new worker that is not ready within this is terminated. */
  spawnTimeoutMs: 10_000,
  /** The worker's own V8 limits (its JS heap; the WASM memory above is outside them). */
  worker: Object.freeze({ maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 8, codeRangeSizeMb: 16, stackSizeMb: 8 }),
});

/** Why a render did not produce output, when a bound (not the template itself) stopped it. */
export type SstiLimit = 'input' | 'timeout' | 'memory' | 'stack' | 'output' | 'busy' | 'crashed';

/** What renderInSandbox answers. `output` when ok; `error` (a message for the player, clipped) when not. */
export interface SstiResult {
  readonly ok: boolean;
  readonly output?: string;
  readonly error?: string;
  /** Set when a sandbox bound stopped the render (see SstiLimit); absent for an ordinary template error. */
  readonly limit?: SstiLimit;
  /** The commands the template ran through the fake child_process, in order (the first 16, each clipped). */
  readonly shellCalls: readonly string[];
}

/**
 * The simulated Node host a template can escape into (FP-07). Data only: it crosses to the worker as JSON-safe
 * strings. With it, the sandbox has a FAKE `process` (env, version, cwd(), mainModule.require) whose
 * `require('child_process').execSync(cmd)` reaches fakeShell; without it, `process` is undefined.
 */
export interface FakeNode {
  /** Files of the simulated machine by absolute path (`cat`, `ls`): plant the flag here, e.g. `/srv/forum/flag`. */
  readonly files?: Readonly<Record<string, string>>;
  /** The fake process.env (and the shell's `$VAR`, `env`, `printenv`), e.g. `{ FLAG: canary }`. */
  readonly env?: Readonly<Record<string, string>>;
}

/** One render as it crosses to the engine: strings, numbers and booleans only (validated by sandbox.ts). */
export interface SandboxJob {
  readonly template: string;
  readonly ctxJson: string;
  readonly autoescape: boolean;
  readonly timeoutMs: number;
  /** The planted machine (null: no fake Node host, `process` is undefined in the sandbox). */
  readonly node: { readonly files: readonly (readonly [string, string])[]; readonly env: readonly (readonly [string, string])[] } | null;
}

/** The two files the engine needs, read once: the compiled QuickJS module and the Nunjucks browser bundle. */
export interface EngineAssets {
  readonly wasm: WebAssembly.Module;
  readonly nunjucks: string;
}

/**
 * Read and compile the engine's two fixed files: `@jitl/quickjs-wasmfile-release-sync/wasm` and
 * `nunjucks/browser/nunjucks.min.js`, resolved from their packages (from dist/ too: node_modules is next to it).
 * The only node:fs use in core/ssti. Nunjucks is read as TEXT: it is evaluated inside QuickJS, never imported here.
 */
export function loadAssets(): EngineAssets {
  const resolve = createRequire(import.meta.url).resolve;
  const wasm = new WebAssembly.Module(readFileSync(resolve('@jitl/quickjs-wasmfile-release-sync/wasm')));
  const nunjucks = readFileSync(resolve('nunjucks/browser/nunjucks.min.js'), 'utf8');
  return { wasm, nunjucks };
}

const PAGE = 64 * 1024;
/** What a bound answers: one message per limit (the worker transport uses them too). */
export const SSTI_MESSAGES = Object.freeze({
  timeout: (ms: number) => `The template took too long to render (over ${ms} ms).`,
  memory: 'The template ran out of memory.',
  stack: 'The template nested or recursed too deeply (stack overflow).',
  output: `The rendered text is too long (over ${SSTI_LIMITS.outputChars} characters).`,
  crashed: 'The template sandbox failed; it is restarted for the next render.',
  noText: 'The template engine returned no text.',
  failed: 'The template failed.',
});

const fail = (limit: SstiLimit | undefined, error: string, shellCalls: readonly string[]): SstiResult =>
  (limit === undefined ? { ok: false, error, shellCalls } : { ok: false, error, limit, shellCalls });

/**
 * The guest side of a render, evaluated after Nunjucks and before any template: the function the host calls. It
 * builds the Environment (no loaders: include/import/extends find nothing) and parses the context with the pristine
 * JSON.parse, then renders. Whatever the template throws becomes a primitive string, clipped (a guest getter on the
 * error runs here, inside the sandbox and its deadline). It is no security boundary: the host checks what it reads.
 */
const RUNNER = `(function (nunjucks, maxError) {
  'use strict';
  var parse = JSON.parse;
  function describe(e) {
    var m;
    try {
      if (typeof e === 'string') m = e;
      else if (e !== null && typeof e === 'object' && typeof e.message === 'string') m = (typeof e.name === 'string' && e.name !== '' ? e.name + ': ' : '') + e.message;
      else m = '' + e;
    } catch (e2) { m = 'The template failed.'; }
    return m.length > maxError ? m.substring(0, maxError) : m;
  }
  return function (template, ctxJson, autoescape) {
    var env = new nunjucks.Environment([], { autoescape: autoescape });
    var ctx = parse(ctxJson);
    try { return env.renderString(template, ctx); } catch (e) { throw describe(e); }
  };
})`;

/**
 * The fake Node host, evaluated before any template when the lab plants one (FakeNode). `sh` is the one host
 * binding: it takes the command as a string and answers `{"status","stdout","stderr"}` as JSON, so a failing
 * command throws like Node's execSync ("Command failed: ..."). `require` is NOT a global (it is not one in Node
 * either): the template reaches child_process the way real payloads do, through process.mainModule.require.
 */
const FAKE_NODE = `(function (sh, envJson) {
  'use strict';
  var parse = JSON.parse, MakeError = Error, ToString = String;
  var env = parse(envJson);
  function execSync(command) {
    var cmd = ToString(command);
    var r = parse(sh(cmd));
    if (r.status !== 0) {
      var e = new MakeError('Command failed: ' + cmd + (r.stderr ? '\\n' + r.stderr : ''));
      e.status = r.status; e.stdout = r.stdout; e.stderr = r.stderr;
      throw e;
    }
    return r.stdout;
  }
  var childProcess = { execSync: execSync };
  function require(id) {
    var name = ToString(id);
    if (name === 'child_process' || name === 'node:child_process') return childProcess;
    var e = new MakeError("Cannot find module '" + name + "'");
    e.code = 'MODULE_NOT_FOUND';
    throw e;
  }
  var mainModule = { id: '.', filename: '/srv/forum/server.js', loaded: true, paths: ['/srv/forum/node_modules', '/srv/node_modules', '/node_modules'], require: require };
  globalThis.process = {
    title: 'node', version: 'v22.22.0', versions: { node: '22.22.0' }, arch: 'x64', platform: 'linux', pid: 1,
    argv: ['/usr/local/bin/node', '/srv/forum/server.js'], execPath: '/usr/local/bin/node', env: env,
    mainModule: mainModule, cwd: function () { return '/srv/forum'; }
  };
  globalThis.global = globalThis;
})`;

/** A primitive string handle's length, read without running guest code (QuickJS answers it from the string). */
function lengthOf(vm: QuickJSContext, h: QuickJSHandle): number {
  const len = vm.getProp(h, 'length');
  return vm.typeof(len) === 'number' ? vm.getNumber(len) : Infinity;
}

/** Evaluate trusted engine code (Nunjucks, RUNNER, FAKE_NODE); a failure here is an engine fault, not the player's. */
function evalTrusted(vm: QuickJSContext, code: string, filename: string): QuickJSHandle {
  const r = vm.evalCode(code, filename);
  if (r.error) throw new Error(`ssti engine: ${filename} failed to load`);
  return r.value;
}

/** A host exception from inside the WASM instance: a native stack overflow, or a trap/abort (the instance is unusable). */
function hostFault(err: unknown, shellCalls: readonly string[]): SstiResult {
  if (err instanceof RangeError && /call stack/i.test(err.message)) return fail('stack', SSTI_MESSAGES.stack, shellCalls);
  return fail('crashed', SSTI_MESSAGES.crashed, shellCalls);
}

/**
 * Render one job in a FRESH QuickJS-WASM instance with its own linear memory. Nothing a template does, and nothing a
 * QuickJS bug could corrupt, survives into the next render, which may be another player's. The instance is never
 * disposed: dropping it drops its whole memory, which frees everything the render allocated without running
 * QuickJS's own free paths (and a host exception inside the instance, which leaves it inconsistent, needs nothing
 * more). Bounds: an interrupt handler that stops guest code at the deadline or once the instance's memory passes
 * memoryInterruptBytes, QuickJS's memory and stack limits, the WebAssembly.Memory maximum, a render that ends past
 * its deadline counted as a timeout anyway (a native operation such as JSON.stringify runs without interrupt checks),
 * and the input/output caps. Never throws: every failure is an SstiResult. `started` is called once the boot is done,
 * right before the player's code runs (the worker reports it, so the host's watchdog can switch to the render phase).
 */
export async function renderJob(job: SandboxJob, assets: EngineAssets, started?: () => void): Promise<SstiResult> {
  const shellCalls: string[] = [];
  try {
    const memory = new WebAssembly.Memory({ initial: SSTI_LIMITS.wasmInitialBytes / PAGE, maximum: SSTI_LIMITS.wasmMaxBytes / PAGE });
    const qjs = await newQuickJSWASMModuleFromVariant(newVariant(releaseSync, { wasmModule: assets.wasm, wasmMemory: memory }));
    const rt = qjs.newRuntime();
    rt.setMemoryLimit(SSTI_LIMITS.memoryBytes);
    rt.setMaxStackSize(SSTI_LIMITS.stackBytes);
    let deadline = Date.now() + SSTI_LIMITS.bootMs;
    let interrupted = false;
    let overMemory = false;
    rt.setInterruptHandler(() => {
      if (memory.buffer.byteLength > SSTI_LIMITS.memoryInterruptBytes) {
        overMemory = true;
        return true;
      }
      if (Date.now() <= deadline) return false;
      interrupted = true;
      return true;
    });
    const vm = rt.newContext();
    evalTrusted(vm, assets.nunjucks, 'nunjucks.js');
    if (job.node !== null) installFakeNode(vm, job.node, shellCalls);
    const made = vm.callFunction(evalTrusted(vm, RUNNER, 'runner.js'), vm.undefined, vm.getProp(vm.global, 'nunjucks'), vm.newNumber(SSTI_LIMITS.errorChars));
    if (made.error) throw new Error('ssti engine: the runner failed to load');
    const run = made.value;
    const template = vm.newString(job.template);
    const ctxJson = vm.newString(job.ctxJson);
    // The player's code starts here: from now on the deadline is the render's.
    started?.();
    interrupted = false;
    const due = Date.now() + job.timeoutMs;
    deadline = due;
    const r = vm.callFunction(run, vm.undefined, template, ctxJson, job.autoescape ? vm.true : vm.false);
    const late = Date.now() > due;
    deadline = 0; // reading the answer below never runs guest code; if anything did, it would be stopped at once
    if (overMemory) return fail('memory', SSTI_MESSAGES.memory, shellCalls);
    if (interrupted || late) return fail('timeout', SSTI_MESSAGES.timeout(job.timeoutMs), shellCalls);
    if (r.error) {
      // The runner throws a primitive string of at most errorChars. Anything else (an engine error it could not turn
      // into text, or a String.prototype the template tampered with) is never read.
      if (vm.typeof(r.error) !== 'string' || lengthOf(vm, r.error) > SSTI_LIMITS.errorChars) return fail(undefined, SSTI_MESSAGES.failed, shellCalls);
      // The copy is checked again: the guest's length is in UTF-16 code units, and copying turns each lone surrogate
      // into U+FFFD, three host characters (UTF-8 in between). So a copy can be up to three times longer.
      const message = clipText(vm.getString(r.error), SSTI_LIMITS.errorChars);
      if (/\b(out of memory|string too long)\b/.test(message)) return fail('memory', SSTI_MESSAGES.memory, shellCalls);
      if (/\bstack overflow\b/.test(message)) return fail('stack', SSTI_MESSAGES.stack, shellCalls);
      return fail(undefined, message, shellCalls);
    }
    if (vm.typeof(r.value) !== 'string') return fail(undefined, SSTI_MESSAGES.noText, shellCalls);
    if (lengthOf(vm, r.value) > SSTI_LIMITS.outputChars) return fail('output', SSTI_MESSAGES.output, shellCalls);
    const output = vm.getString(r.value);
    if (output.length > SSTI_LIMITS.outputChars) return fail('output', SSTI_MESSAGES.output, shellCalls); // lone surrogates, as above
    return { ok: true, output, shellCalls };
  } catch (err) {
    return hostFault(err, shellCalls);
  }
}

/** Define the fake `process` (FAKE_NODE) with the shell bridge: the guest's only host binding. */
function installFakeNode(vm: QuickJSContext, node: NonNullable<SandboxJob['node']>, shellCalls: string[]): void {
  const machine = machineOf(node);
  let calls = 0;
  const sh = vm.newFunction('sh', (arg) => {
    calls += 1;
    let cmd: string | undefined;
    if (vm.typeof(arg) === 'string' && lengthOf(vm, arg) <= SSTI_LIMITS.shellCommandChars) cmd = vm.getString(arg);
    if (cmd !== undefined && cmd.length > SSTI_LIMITS.shellCommandChars) cmd = undefined; // lone surrogates grew it
    if (shellCalls.length < SSTI_LIMITS.shellCallsKept) {
      shellCalls.push(cmd === undefined ? '(an over-long command)' : clipText(cmd, SSTI_LIMITS.shellCallChars));
    }
    let res: ShellResult;
    if (calls > SSTI_LIMITS.shellCallsPerRender) res = { status: 2, stdout: '', stderr: 'sh: 1: Cannot fork' };
    else if (cmd === undefined) res = { status: 2, stdout: '', stderr: 'sh: 1: command too long' };
    else res = runShell(machine, cmd);
    return vm.newString(JSON.stringify(res));
  });
  const env = vm.newString(JSON.stringify(Object.fromEntries(machine.env)));
  const r = vm.callFunction(evalTrusted(vm, FAKE_NODE, 'fake-node.js'), vm.undefined, sh, env);
  if (r.error) throw new Error('ssti engine: the fake node failed to load');
}

/** At most `max` code units, never ending in half a surrogate pair (a slice of a short string, kept for one result). */
export function clipText(s: string, max: number): string {
  if (s.length <= max) return s;
  const end = /[\uD800-\uDBFF]/.test(s[max - 1]) ? max - 1 : max;
  return s.slice(0, end);
}

// ---------------------------------------------------------------------------------------------------------------
// The fake shell. It runs on the HOST side of the sandbox (in the worker), over the data the lab planted: a tiny
// allow-list of commands, simple sequences, no pipes, redirections or substitutions, and no real process ever.
// ---------------------------------------------------------------------------------------------------------------

/** What one command line printed: Node's execSync throws "Command failed" for a non-zero status. */
export interface ShellResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The simulated machine of one render: the planted files (with their directories) and environment. */
interface Machine {
  readonly files: ReadonlyMap<string, string>;
  readonly dirs: ReadonlySet<string>;
  readonly env: ReadonlyMap<string, string>;
}

/** The simulated user, host and working directory: fictional on purpose, so output never looks like the real host. */
export const FAKE_HOST = Object.freeze({
  user: 'scribe',
  uid: 1000,
  hostname: 'forum-of-pilgrims',
  cwd: '/srv/forum',
  home: '/home/scribe',
});

/** Files every simulated machine has; a lab's planted files are added (and win on the same path). */
const BASE_FILES: readonly (readonly [string, string])[] = [
  ['/etc/hostname', `${FAKE_HOST.hostname}\n`],
  ['/etc/passwd', `root:x:0:0:root:/root:/bin/sh\n${FAKE_HOST.user}:x:${FAKE_HOST.uid}:${FAKE_HOST.uid}::${FAKE_HOST.home}:/bin/sh\n`],
];

/** A path made absolute against `cwd`, with `.`/`..`/empty segments resolved (never above `/`). */
export function resolveShellPath(cwd: string, path: string): string {
  const out: string[] = [];
  for (const seg of `${path.startsWith('/') ? '' : cwd}/${path}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}

function machineOf(node: NonNullable<SandboxJob['node']>): Machine {
  const files = new Map<string, string>();
  for (const [path, content] of [...BASE_FILES, ...node.files]) files.set(resolveShellPath('/', path), content);
  const dirs = new Set<string>(['/']);
  for (const path of files.keys()) {
    for (let i = path.indexOf('/', 1); i !== -1; i = path.indexOf('/', i + 1)) dirs.add(path.slice(0, i));
  }
  for (const d of [FAKE_HOST.cwd, FAKE_HOST.home, '/tmp']) {
    for (let p = d; p !== '/'; p = p.slice(0, p.lastIndexOf('/')) || '/') dirs.add(p);
  }
  const env = new Map<string, string>([['NODE_ENV', 'production'], ['HOME', FAKE_HOST.home], ['USER', FAKE_HOST.user],
    ['PATH', '/usr/local/bin:/usr/bin:/bin'], ['PWD', FAKE_HOST.cwd], ...node.env]);
  return { files, dirs, env };
}

/** A token or an operator of a command line. */
type Tok = { readonly word: string } | { readonly op: ';' | '&&' | '||' };

const UNSUPPORTED = 'sh: 1: this simulated shell runs simple commands only (no pipes, redirections or substitutions)';

/** Split a command line into words (quotes, backslashes and $VAR expansion as sh does) and sequence operators. */
function tokenize(line: string, env: ReadonlyMap<string, string>): Tok[] | undefined {
  const toks: Tok[] = [];
  let word = '';
  let inWord = false;
  const flush = () => {
    if (inWord) toks.push({ word });
    word = '';
    inWord = false;
  };
  const expand = (i: number): [string, number] => {
    const braced = line[i + 1] === '{';
    const start = braced ? i + 2 : i + 1;
    let j = start;
    while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) j += 1;
    const name = line.slice(start, j);
    if (name === '') return ['$', i + 1];
    if (braced) {
      if (line[j] !== '}') return ['$', i + 1];
      j += 1;
    }
    return [env.get(name) ?? '', j];
  };
  for (let i = 0; i < line.length;) {
    const c = line[i];
    if (c === ' ' || c === '\t') { flush(); i += 1; continue; }
    if (c === '\n' || c === ';') { flush(); toks.push({ op: ';' }); i += 1; continue; }
    if (c === '&' && line[i + 1] === '&') { flush(); toks.push({ op: '&&' }); i += 2; continue; }
    if (c === '|' && line[i + 1] === '|') { flush(); toks.push({ op: '||' }); i += 2; continue; }
    if (c === '|' || c === '&' || c === '<' || c === '>' || c === '`' || (c === '$' && line[i + 1] === '(')) return undefined;
    inWord = true;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) return undefined;
      word += line.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j += 1) {
        if (line[j] === '\\' && j + 1 < line.length && '"\\$`'.includes(line[j + 1])) { word += line[j + 1]; j += 1; }
        else if (line[j] === '`' || (line[j] === '$' && line[j + 1] === '(')) return undefined;
        else if (line[j] === '$') { const [v, next] = expand(j); word += v; j = next - 1; }
        else word += line[j];
      }
      if (j >= line.length) return undefined;
      i = j + 1;
    } else if (c === '\\') {
      word += line[i + 1] ?? '';
      i += 2;
    } else if (c === '$') {
      const [v, next] = expand(i);
      word += v;
      i = next;
    } else {
      word += c;
      i += 1;
    }
  }
  flush();
  return toks;
}

/** One simple command of the allow-list. `state.cwd` is the only thing a command changes (`cd`). */
function runCommand(m: Machine, state: { cwd: string }, argv: readonly string[]): ShellResult {
  const [name, ...args] = argv;
  const ok = (stdout: string): ShellResult => ({ status: 0, stdout, stderr: '' });
  const err = (status: number, stderr: string): ShellResult => ({ status, stdout: '', stderr });
  const path = (p: string) => resolveShellPath(state.cwd, p);
  switch (name) {
    case 'id': return ok(`uid=${FAKE_HOST.uid}(${FAKE_HOST.user}) gid=${FAKE_HOST.uid}(${FAKE_HOST.user}) groups=${FAKE_HOST.uid}(${FAKE_HOST.user})\n`);
    case 'whoami': return ok(`${FAKE_HOST.user}\n`);
    case 'hostname': return ok(`${FAKE_HOST.hostname}\n`);
    case 'pwd': return ok(`${state.cwd}\n`);
    case 'uname': return ok(args.includes('-a') ? `Linux ${FAKE_HOST.hostname} 6.6.0-hvwa #1 SMP x86_64 GNU/Linux\n` : 'Linux\n');
    case 'echo': return ok(`${args.join(' ')}\n`);
    case 'env': return ok([...m.env].map(([k, v]) => `${k}=${v}\n`).join(''));
    case 'printenv': {
      if (args.length === 0) return ok([...m.env].map(([k, v]) => `${k}=${v}\n`).join(''));
      const values = args.map((a) => m.env.get(a));
      const shown = values.filter((v): v is string => v !== undefined).map((v) => `${v}\n`).join('');
      return { status: values.includes(undefined) ? 1 : 0, stdout: shown, stderr: '' };
    }
    case 'cd': {
      const to = path(args[0] ?? FAKE_HOST.home);
      if (!m.dirs.has(to)) return err(2, `sh: 1: cd: can't cd to ${args[0] ?? ''}`);
      state.cwd = to;
      return ok('');
    }
    case 'ls': {
      const targets = args.filter((a) => !a.startsWith('-'));
      let stdout = '';
      let stderr = '';
      for (const t of targets.length > 0 ? targets : ['.']) {
        const p = path(t);
        if (m.files.has(p)) { stdout += `${t}\n`; continue; }
        if (!m.dirs.has(p)) { stderr += `ls: cannot access '${t}': No such file or directory\n`; continue; }
        const prefix = p === '/' ? '/' : `${p}/`;
        const names = new Set<string>();
        for (const e of [...m.files.keys(), ...m.dirs]) {
          if (e !== p && e.startsWith(prefix)) names.add(e.slice(prefix.length).split('/')[0]);
        }
        stdout += [...names].sort().map((n) => `${n}\n`).join('');
      }
      return { status: stderr === '' ? 0 : 2, stdout, stderr: stderr.replace(/\n$/, '') };
    }
    case 'cat': {
      let stdout = '';
      let stderr = '';
      for (const a of args) {
        const p = path(a);
        const content = m.files.get(p);
        if (content !== undefined) stdout += content;
        else stderr += m.dirs.has(p) ? `cat: ${a}: Is a directory\n` : `cat: ${a}: No such file or directory\n`;
      }
      return { status: stderr === '' ? 0 : 1, stdout, stderr: stderr.replace(/\n$/, '') };
    }
    default: return err(127, `sh: 1: ${name}: not found`);
  }
}

function runShell(m: Machine, line: string): ShellResult {
  const toks = tokenize(line, m.env);
  if (toks === undefined) return { status: 2, stdout: '', stderr: UNSUPPORTED };
  const state = { cwd: FAKE_HOST.cwd };
  let stdout = '';
  let stderr = '';
  let status = 0;
  let skip = false;
  let argv: string[] = [];
  const end = (op: ';' | '&&' | '||' | undefined) => {
    if (argv.length > 0 && !skip) {
      const r = runCommand(m, state, argv);
      stdout += r.stdout;
      if (r.stderr !== '') stderr += `${stderr === '' ? '' : '\n'}${r.stderr}`;
      status = r.status;
    }
    argv = [];
    skip = op === '&&' ? status !== 0 : op === '||' ? status === 0 : false;
  };
  for (const t of toks) {
    if ('op' in t) end(t.op);
    else argv.push(t.word);
  }
  end(undefined);
  return { status, stdout: clipText(stdout, SSTI_LIMITS.shellOutputChars), stderr: clipText(stderr, SSTI_LIMITS.shellOutputChars) };
}

/**
 * What the fake child_process answers for `command` on a machine with `node` planted: the same function the
 * sandbox's bridge calls (exported for the shell's own tests).
 */
export function fakeShell(node: FakeNode, command: string): ShellResult {
  return runShell(machineOf({ files: Object.entries(node.files ?? {}), env: Object.entries(node.env ?? {}) }), command);
}

// ---------------------------------------------------------------------------------------------------------------
// The worker side: loaded by transport.ts with workerData { hvwaSsti: WORKER_TAG }. One render at a time.
// ---------------------------------------------------------------------------------------------------------------

/** workerData tag that makes this module run as the SSTI worker (any other worker that imports it stays inert). */
export const WORKER_TAG = 'hvwa-ssti/1';

/** Every host function the worker realm loses once its two files are read (the same list the guard spies on). */
export const SEALED_FUNCTIONS: readonly (readonly [string, readonly string[]])[] = [
  ['node:fs', ['readFile', 'readFileSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'open', 'openSync',
    'mkdir', 'mkdirSync', 'createReadStream', 'createWriteStream', 'readdir', 'readdirSync', 'stat', 'statSync', 'unlink',
    'unlinkSync', 'rename', 'renameSync', 'rm', 'rmSync', 'cp', 'cpSync', 'symlink', 'symlinkSync', 'watch']],
  ['node:fs/promises', ['readFile', 'writeFile', 'appendFile', 'open', 'mkdir', 'readdir', 'stat', 'unlink', 'rename', 'rm', 'cp']],
  ['node:http', ['request', 'get', 'createServer']], ['node:https', ['request', 'get', 'createServer']],
  ['node:http2', ['connect', 'createServer']], ['node:tls', ['connect', 'createServer']],
  ['node:net', ['connect', 'createConnection', 'createServer']], ['node:dgram', ['createSocket']],
  ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']],
  ['node:child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
  ['node:vm', ['runInNewContext', 'runInThisContext', 'runInContext', 'compileFunction', 'createContext']],
];

/**
 * Worker diagnostics (the stats message): renders done, functions sealed, sealed calls attempted since, and whether
 * this module's own ES-module binding of readFileSync now IS the seal (checked right after sealing, before any call).
 */
export interface WorkerStats {
  readonly renders: number;
  readonly sealed: number;
  readonly sealHits: number;
  readonly sealVerified: boolean;
}

let sealHits = 0;

/** Replace every SEALED_FUNCTIONS entry in THIS realm (the worker's own module objects) with one that throws. */
function sealWorker(): number {
  const load = createRequire(import.meta.url);
  let sealed = 0;
  for (const [id, names] of SEALED_FUNCTIONS) {
    const mod = load(id) as Record<string, unknown>;
    for (const name of names) {
      if (typeof mod[name] !== 'function') continue;
      mod[name] = () => {
        sealHits += 1;
        throw new Error(`ssti worker: ${id} ${name} is sealed`);
      };
      sealed += 1;
    }
  }
  syncBuiltinESMExports(); // ES-module bindings (this file's own readFileSync included) now point at the seals too
  return sealed;
}

/**
 * One trivial render through every part of the engine (the fake Node host included). The first instance imports
 * QuickJS's FFI and Emscripten loader, and Node's module loader reads them with node:fs: so a worker warms up BEFORE
 * it seals itself (and the guard spec before its spies). Throws if the render fails.
 */
export async function warmUp(assets: EngineAssets): Promise<void> {
  const r = await renderJob({
    template: '{{ 6 * 7 }}', ctxJson: '{}', autoescape: true, timeoutMs: SSTI_LIMITS.maxTimeoutMs, node: { files: [], env: [] },
  }, assets);
  if (!r.ok || r.output !== '42') throw new Error(`ssti engine: the warm-up render failed (${r.error ?? 'wrong output'})`);
}

/** Messages between transport.ts and the worker. */
export type ToWorker = { readonly type: 'render'; readonly id: number; readonly job: SandboxJob } | { readonly type: 'stats'; readonly id: number };
export type FromWorker =
  | { readonly type: 'ready' }
  | { readonly type: 'started'; readonly id: number }
  | { readonly type: 'fatal'; readonly message: string }
  | { readonly type: 'result'; readonly id: number; readonly result: SstiResult }
  | { readonly type: 'stats'; readonly id: number; readonly stats: WorkerStats };

async function workerMain(): Promise<void> {
  const port = parentPort;
  if (port === null) return;
  let assets: EngineAssets;
  let sealed: number;
  let sealVerified: boolean;
  try {
    assets = loadAssets();
    await warmUp(assets); // imports what a render loads lazily, while the worker can still read files
    const unsealed = readFileSync;
    sealed = sealWorker();
    sealVerified = readFileSync !== unsealed;
    await warmUp(assets); // and a sealed worker still renders
  } catch (err) {
    port.postMessage({ type: 'fatal', message: err instanceof Error ? err.message : String(err) } satisfies FromWorker);
    return;
  }
  let renders = 0;
  let chain: Promise<void> = Promise.resolve();
  port.on('message', (m: ToWorker) => {
    chain = chain.then(async () => {
      if (m.type === 'render') {
        const result = await renderJob(m.job, assets, () => port.postMessage({ type: 'started', id: m.id } satisfies FromWorker));
        renders += 1;
        port.postMessage({ type: 'result', id: m.id, result } satisfies FromWorker);
      } else if (m.type === 'stats') {
        const stats: WorkerStats = { renders, sealed, sealHits, sealVerified };
        port.postMessage({ type: 'stats', id: m.id, stats } satisfies FromWorker);
      }
    });
  });
  port.postMessage({ type: 'ready' } satisfies FromWorker);
}

if (!isMainThread && (workerData as { hvwaSsti?: unknown } | null)?.hvwaSsti === WORKER_TAG) await workerMain();
