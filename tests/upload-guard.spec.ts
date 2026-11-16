// The upload engine never reaches the real filesystem, the network, or anything that runs code: core/upload.ts,
// core/upload-zip.ts and core/simfs.ts are parsed with the TypeScript compiler and may import only an allow-list
// (node:buffer, node:zlib, each other, core/sim/limits.ts, and core/lab.ts for simfs's per-session cap), never load
// code dynamically and name no network or code-loading global. Then a full upload, archive and interpreter run is
// made with the fs, network, child-process and vm functions spied (for ES-module importers too, through
// syncBuiltinESMExports): none may be called. (Same style as the core/sim/ guard in tests/sim.spec.ts.)
import { readFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { runInNewContext } from 'node:vm';
import net from 'node:net';
import ts from 'typescript';
import { afterAll, describe, it, expect, vi } from 'vitest';
import { perSession } from '../src/core/lab.js';
import { looksLikeImage, parseMultipart } from '../src/core/upload.js';
import { readZip } from '../src/core/upload-zip.js';
import { simFs, simInterpret } from '../src/core/simfs.js';
import { multipart, uploadReq, zipOf } from './support/uploads.js';

const socketConnect = vi.spyOn(net.Socket.prototype, 'connect');
afterAll(() => {
  const calls = socketConnect.mock.calls.length;
  socketConnect.mockRestore();
  expect(calls, 'a socket was opened while the upload guard ran').toBe(0);
});

const CORE = new URL('../src/core/', import.meta.url);
const MODULES = ['upload.ts', 'upload-zip.ts', 'simfs.ts'] as const;
/** Runtime imports these modules may have (type-only imports are erased). node:fs, net, http, child_process, vm ... are not here. */
const ALLOWED: ReadonlySet<string> = new Set([
  'node:buffer', 'node:zlib', './upload.js', './upload-zip.js', './simfs.js', './sim/limits.js', './lab.js',
]);
/*
 * WHAT THE STATIC SCAN IS FOR: it catches ACCIDENTS (someone adding `import ... from 'node:fs'`, a `fetch`, an `eval`)
 * in the engine's own code. It is NOT a sandbox against hostile code: a computed name (`({})['con' + 'structor']`), a
 * template substitution or `String.fromCharCode(...)` still spells a way to Function that no source scan can see.
 * The backstop is the runtime traps below: every fs, network, child-process and vm function throws during the whole
 * flow. (Uploaded bytes never reach any of this as code: simInterpret only pattern-matches them.)
 */

/**
 * Names that reach the network or load or run code, however the call site spells the rest: globals, and
 * `constructor` (`(() => 0).constructor` is the Function constructor without naming Function). Flagged as an
 * identifier and as a string literal (`Reflect.get(o, 'fetch')`, `x['constructor']`). `Response` (the WHATWG body
 * parser parseMultipart uses) is not one: it parses a Buffer in memory and never fetches. A class's `constructor()`
 * is a declaration, not a name, and is not flagged.
 */
const DENIED_GLOBALS: ReadonlySet<string> = new Set([
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'globalThis', 'global', 'window', 'self', 'process', 'require',
  'module', 'eval', 'Function', 'WebAssembly', 'Worker', 'Deno', 'Bun', 'constructor',
]);

function sourceCheck(src: string): { runtime: string[]; problems: string[] } {
  const sf = ts.createSourceFile('m.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const runtime: string[] = [];
  const problems: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.importClause?.isTypeOnly) runtime.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) runtime.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node)) {
      problems.push('import = require');
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      problems.push('dynamic import()');
    } else if ((ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && DENIED_GLOBALS.has(node.text)) {
      problems.push(`${node.text} (line ${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { runtime, problems };
}

/** Every module a core file loads at runtime, transitively: the core files reached and the outside modules each imports. */
function closure(start: readonly string[]): { files: string[]; outside: Map<string, string[]> } {
  const seen = new Set<string>();
  const outside = new Map<string, string[]>();
  const walk = (file: URL): void => {
    if (seen.has(file.href)) return;
    seen.add(file.href);
    for (const m of sourceCheck(readFileSync(file, 'utf8')).runtime) {
      if (m.startsWith('.')) walk(new URL(m.replace(/\.js$/, '.ts'), file));
      else outside.set(m, [...(outside.get(m) ?? []), file.href.slice(CORE.href.length)]);
    }
  };
  for (const f of start) walk(new URL(f, CORE));
  return { files: [...seen].map((h) => h.slice(CORE.href.length)).sort(), outside };
}

describe('the upload engine imports no filesystem, network or code runner', () => {
  it('the guard flags every way to reach a module or a global it does not allow (self-test)', () => {
    const evasions = [
      "import 'node:fs';", "import { readFileSync } from 'fs';", "import * as p from 'node:fs/promises';", "import 'node:http';",
      "export { connect } from 'node:net';", "import d = require('node:dns');", "const r = require('node:child_process');",
      "import { runInNewContext } from 'node:vm';", "import { Worker } from 'node:worker_threads';", 'const m = await import(`node:fs`);',
      "globalThis['fe' + 'tch']('http://x');", "fetch('http://x');", 'process.binding("fs");', "(0, eval)('1');", "Function('return 1')();",
      "new WebAssembly.Module(b);", "import x from 'express';",
      // The Function constructor without naming Function, and globals named by a string.
      "(() => 0).constructor('return 1')();", "const k = 'constructor'; ({})[k][k]('return 1')();", 'Reflect.get(Object, `constructor`);',
      "const g = Reflect.get(Object.getPrototypeOf(Math), 'globalThis');", "Reflect.get(x, 'fetch')('http://x');", "o['process'];",
    ];
    for (const src of evasions) {
      const { runtime, problems } = sourceCheck(src);
      expect([...runtime.filter((m) => !ALLOWED.has(m)), ...problems], src).not.toEqual([]);
    }
    expect(sourceCheck("import type { Request } from 'express'; import { inflateRawSync } from 'node:zlib'; new Response(b);"))
      .toEqual({ runtime: ['node:zlib'], problems: [] });
    // A class constructor is a declaration, not the name; a string that merely contains a denied word is fine.
    expect(sourceCheck("class E extends Error { constructor() { super('fetching the process-wide budget'); } }"))
      .toEqual({ runtime: [], problems: [] });
  });

  it('each module imports only the allow-list, never loads code dynamically', () => {
    for (const file of MODULES) {
      const { runtime, problems } = sourceCheck(readFileSync(new URL(file, CORE), 'utf8'));
      expect(runtime.filter((m) => !ALLOWED.has(m)), file).toEqual([]);
      expect(problems, file).toEqual([]);
    }
  });

  it('no file the three modules reach, transitively, names a denied global (as a name or a string)', () => {
    const { files } = closure(MODULES);
    expect(files).toEqual(['lab.ts', 'levels.ts', 'sim/limits.ts', 'simfs.ts', 'upload-zip.ts', 'upload.ts']);
    for (const file of files) expect(sourceCheck(readFileSync(new URL(file, CORE), 'utf8')).problems, file).toEqual([]);
  });

  it('the multipart parser and the zip reader reach only node:buffer and node:zlib, transitively', () => {
    const { files, outside } = closure(['upload.ts', 'upload-zip.ts']);
    expect(files).toEqual(['sim/limits.ts', 'upload-zip.ts', 'upload.ts']);
    expect([...outside.keys()].sort()).toEqual(['node:buffer', 'node:zlib']);
  });

  it('simfs adds core/lab.ts (its perSession cap) and still reaches only node:buffer (lab fixtures live in core/fixtures.ts)', () => {
    const { files, outside } = closure(['simfs.ts']);
    expect(files).toEqual(['lab.ts', 'levels.ts', 'sim/limits.ts', 'simfs.ts', 'upload.ts']);
    expect([...outside.keys()]).toEqual(['node:buffer']);
  });
});

/**
 * Trap every filesystem, network, child-process and vm function: each becomes a spy that THROWS `guard: <name>` and
 * never calls the real function, so a regression fails the test instead of touching the disk, the network or a
 * process. The spies sit on the CommonJS export objects; syncBuiltinESMExports() then points the builtins'
 * ES-module bindings at them too, so a module that did `import { readFileSync } from 'node:fs'` is trapped as well
 * (without it, ESM callers would reach the real functions: the self-test checks the bindings before any call).
 */
function installSpies() {
  const require = createRequire(import.meta.url);
  const trap = (mod: object, name: string) =>
    vi.spyOn(mod as Record<string, () => unknown>, name).mockImplementation(() => { throw new Error(`guard: ${name}`); });
  const on = (id: string, fns: readonly string[]) => {
    const mod = require(id) as Record<string, unknown>;
    return fns.filter((f) => typeof mod[f] === 'function').map((f) => trap(mod, f));
  };
  const fsFns = ['readFile', 'readFileSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'open', 'openSync', 'mkdir',
    'mkdirSync', 'createReadStream', 'createWriteStream', 'readdir', 'readdirSync', 'stat', 'statSync', 'unlink', 'unlinkSync', 'rename', 'renameSync'];
  const fsPromises = require('node:fs/promises') as object;
  const dns = require('node:dns') as { promises: object };
  const spies = [
    trap(globalThis, 'fetch'),
    ...on('node:fs', fsFns),
    ...(['readFile', 'writeFile', 'appendFile', 'open', 'mkdir', 'readdir', 'stat', 'unlink', 'rename'] as const).map((f) => trap(fsPromises, f)),
    ...on('node:http', ['request', 'get']), ...on('node:https', ['request', 'get']), ...on('node:http2', ['connect']),
    ...on('node:tls', ['connect']), ...on('node:net', ['connect', 'createConnection']), ...on('node:dgram', ['createSocket']),
    ...on('node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']),
    ...(['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny'] as const).map((f) => trap(dns.promises, f)),
    ...on('node:child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']),
    ...on('node:vm', ['runInNewContext', 'runInThisContext', 'runInContext', 'compileFunction', 'createContext']),
  ];
  syncBuiltinESMExports();
  return spies;
}
function releaseSpies(spies: ReturnType<typeof installSpies>): void {
  for (const spy of spies) spy.mockRestore();
  syncBuiltinESMExports();
}

/** The whole flow a lab runs: parse an upload, sniff it, unzip, store into a simFs, "run" two files. */
async function wholeFlow(sessionId: string): Promise<void> {
  const archive = zipOf([{ name: '../../templates/welcome.txt', data: "hvwa('CANARY')" }, { name: 'shell.php', data: '<?hvwa CANARY ?>', method: 'stored' }]);
  const body = multipart([
    { name: 'caption', value: 'restore' },
    { name: 'archive', filename: '../backup.zip', contentType: 'application/zip', value: archive },
    { name: 'sigil', filename: 'x.gif', contentType: 'image/gif', value: Buffer.from('GIF89a\x01\x00\x01\x00\xf7\x00\x00<?hvwa CANARY ?>', 'latin1') },
  ]);
  const up = await parseMultipart(uploadReq(body));
  expect(up.files.map((f) => f.filename)).toEqual(['../backup.zip', 'x.gif']);
  expect(looksLikeImage(up.files[1].bytes)).toBe(true);
  const fs = perSession(() => simFs()).for({ sessionId, level: 'acolyte' });
  fs.write('/srv/app/templates/welcome.txt', 'Welcome.', { pinned: true });
  for (const e of readZip(up.files[0].bytes)) fs.write(`/srv/app/uploads/restore/${e.name}`, e.bytes);
  fs.write(`/srv/app/uploads/${up.files[1].filename}`, up.files[1].bytes, { contentType: up.files[1].contentType });
  expect(fs.read('/srv/app/templates/welcome.txt')?.bytes.toString()).toBe("hvwa('CANARY')");
  expect(simInterpret(fs.read('/srv/app/uploads/restore/shell.php')?.bytes ?? Buffer.alloc(0), 'canary')).toBe('canary');
  expect(simInterpret(fs.read('/srv/app/uploads/x.gif')?.bytes ?? Buffer.alloc(0), 'canary')).toBe('canary');
}

describe('a whole upload, archive and "execution" touches no filesystem, network, child-process or vm function', () => {
  it('the spies throw instead of passing through, and reach ES-module imports (self-test, nothing real is called)', () => {
    const spies = installSpies();
    try {
      // Every spy has a throwing implementation: a call can never reach the real function.
      for (const spy of spies) expect(spy.getMockImplementation(), spy.getMockName()).toBeDefined();
      // This module's own ESM imports ARE the spies, checked before any call (without syncBuiltinESMExports they are
      // the real functions).
      expect([vi.isMockFunction(readFileSync), vi.isMockFunction(runInNewContext)]).toEqual([true, true]);
      expect(() => readFileSync(new URL(import.meta.url), 'utf8')).toThrow('guard: readFileSync');
      expect(() => runInNewContext('6 * 7')).toThrow('guard: runInNewContext');
    } finally {
      releaseSpies(spies);
    }
    // Restored for ESM callers too: the bindings point at the real functions again.
    expect([vi.isMockFunction(readFileSync), vi.isMockFunction(runInNewContext)]).toEqual([false, false]);
  });

  it('parse -> sniff -> unzip -> store -> interpret, with every such function spied', async () => {
    await wholeFlow('guard-warm-up'); // first use loads what it lazily needs, before the spies go on
    const spies = installSpies();
    try {
      await wholeFlow('guard');
      expect(spies.length).toBeGreaterThan(40);
      for (const spy of spies) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
    } finally {
      releaseSpies(spies);
    }
  });
});
