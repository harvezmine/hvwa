// src/core/ssti/sandbox.ts — the SSTI labs' one entry point (FP-06, FP-07; docs/RECIPES.md section 14):
// renderInSandbox() renders a Nunjucks template INSIDE a QuickJS-WASM sandbox, in a worker_thread, and answers what
// it printed. The lab decides what the template SOURCE is (the level's flaw: player input concatenated in, or a
// constant with the input as data); the sandbox only bounds what that source can do. Nothing ever runs on the host:
// "RCE" is the template reaching a fake child_process whose shell answers from files the lab planted (FakeNode).
//
// Everything a render takes is checked HERE, on the calling thread, before it crosses: the template and the context
// are bounded strings (the context JSON data only), and what the lab plants is bounded too. A template too long or a
// context too big is the player's input, answered `limit: 'input'`; a malformed call is a lab bug and throws.
import {
  SSTI_LIMITS, type FakeNode, type SandboxJob, type SstiResult,
} from './engine.js';
import { workerTransport, type SandboxTransport } from './transport.js';

export { SSTI_LIMITS, FAKE_HOST, fakeShell, type FakeNode, type ShellResult, type SstiLimit, type SstiResult } from './engine.js';
export { inThreadTransport, workerTransport, type SandboxTransport, type WorkerTransport, type WorkerTransportStats } from './transport.js';

/** What a context may hold: JSON data (template variables cannot be functions: nothing but data crosses). */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** One render (see renderInSandbox). */
export interface SandboxInput {
  /** The template SOURCE Nunjucks compiles: whatever the level built (at most SSTI_LIMITS.templateChars). */
  readonly template: string;
  /** Template variables: JSON data only, at most SSTI_LIMITS.ctxChars as JSON. Plant FP-06's `secret` here. */
  readonly ctx?: { readonly [key: string]: JsonValue };
  /** The simulated Node host (FP-07): without it, `process` is undefined in the sandbox and nothing can be "run". */
  readonly node?: FakeNode;
  /** Render deadline in ms, 1 to SSTI_LIMITS.maxTimeoutMs (default SSTI_LIMITS.defaultTimeoutMs, 250). */
  readonly timeoutMs?: number;
  /** Nunjucks autoescape (default true, as Divine needs; a level may turn it off in its own file). */
  readonly autoescape?: boolean;
}

const MAX_CTX_VALUES = 2000;
const MAX_CTX_DEPTH = 32;

/** Throws unless `v` is JSON data (finite numbers, plain objects and arrays), within a value count and depth. */
function assertJson(v: unknown, depth: number, budget: { n: number }): void {
  budget.n += 1;
  if (budget.n > MAX_CTX_VALUES || depth > MAX_CTX_DEPTH) throw new RangeError('renderInSandbox: ctx is too big or too deep');
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError('renderInSandbox: ctx numbers must be finite');
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) assertJson(x, depth + 1, budget);
    return;
  }
  if (typeof v === 'object') {
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('renderInSandbox: ctx objects must be plain objects');
    for (const x of Object.values(v)) assertJson(x, depth + 1, budget);
    return;
  }
  throw new TypeError(`renderInSandbox: ctx may hold JSON data only (got a ${typeof v})`);
}

function plantedEntries(what: string, rec: unknown, max: number, keyOk: (k: string) => boolean, maxValue: number): [string, string][] {
  if (rec === undefined) return [];
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) throw new TypeError(`renderInSandbox: node.${what} must be a plain object`);
  const entries = Object.entries(rec);
  if (entries.length > max) throw new RangeError(`renderInSandbox: node.${what} holds at most ${max} entries`);
  return entries.map(([k, v]) => {
    if (!keyOk(k)) throw new TypeError(`renderInSandbox: node.${what} has an invalid name: ${JSON.stringify(k.slice(0, 64))}`);
    if (typeof v !== 'string' || v.length > maxValue) throw new TypeError(`renderInSandbox: node.${what}[${JSON.stringify(k.slice(0, 64))}] must be a string of at most ${maxValue} characters`);
    return [k, v];
  });
}

/** The job that crosses to the engine, or the answer for an input over the caps. Throws for a malformed call. */
export function toJob(input: SandboxInput): SandboxJob | SstiResult {
  if (input === null || typeof input !== 'object') throw new TypeError('renderInSandbox: expected { template, ctx?, node?, timeoutMs?, autoescape? }');
  const { template, ctx = {}, node, timeoutMs = SSTI_LIMITS.defaultTimeoutMs, autoescape = true } = input;
  if (typeof template !== 'string') throw new TypeError('renderInSandbox: template must be a string');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SSTI_LIMITS.maxTimeoutMs) {
    throw new RangeError(`renderInSandbox: timeoutMs must be an integer from 1 to ${SSTI_LIMITS.maxTimeoutMs} (got ${String(timeoutMs)})`);
  }
  if (typeof autoescape !== 'boolean') throw new TypeError('renderInSandbox: autoescape must be a boolean');
  if (ctx === null || typeof ctx !== 'object' || Array.isArray(ctx)) throw new TypeError('renderInSandbox: ctx must be a plain object');
  assertJson(ctx, 0, { n: 0 });
  let planted: SandboxJob['node'] = null;
  if (node !== undefined) {
    if (node === null || typeof node !== 'object') throw new TypeError('renderInSandbox: node must be { files?, env? }');
    const files = plantedEntries('files', node.files, SSTI_LIMITS.nodeFiles,
      (k) => k.startsWith('/') && k.length <= SSTI_LIMITS.nodePathChars && !k.includes('\0'), SSTI_LIMITS.nodeFileChars);
    const env = plantedEntries('env', node.env, SSTI_LIMITS.nodeEnvVars, (k) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k), SSTI_LIMITS.nodeEnvChars);
    planted = { files, env };
  }
  if (template.length > SSTI_LIMITS.templateChars) {
    return { ok: false, limit: 'input', error: `The template is too long (at most ${SSTI_LIMITS.templateChars} characters).`, shellCalls: [] };
  }
  const ctxJson = JSON.stringify(ctx);
  if (ctxJson.length > SSTI_LIMITS.ctxChars) {
    return { ok: false, limit: 'input', error: `The template data is too large (at most ${SSTI_LIMITS.ctxChars} characters as JSON).`, shellCalls: [] };
  }
  return { template, ctxJson, autoescape, timeoutMs, node: planted };
}

let transport: SandboxTransport | undefined;

/**
 * Render `template` with Nunjucks inside the sandbox, with `ctx` as its variables and, when `node` is given, a fake
 * Node host (`process.env`, `process.mainModule.require('child_process').execSync`) whose shell answers from the
 * planted files. Bounded by a deadline, QuickJS's memory and stack limits, the WASM memory maximum and the output cap
 * (SSTI_LIMITS). Resolves to an SstiResult and never rejects for anything the template does: a template error is
 * `{ ok: false, error }`, a bound `{ ok: false, error, limit }` (`'busy'`: answer 503 with Retry-After).
 */
export function renderInSandbox(input: SandboxInput): Promise<SstiResult> {
  const job = toJob(input);
  if (!('template' in job)) return Promise.resolve(job);
  transport ??= workerTransport();
  return transport.render(job);
}

/**
 * Test seam: route renders through `t` (e.g. inThreadTransport()), or `undefined` for the default worker (made on
 * the next render). Returns the previous transport, so a test can restore it; it does NOT close it.
 */
export function setSandboxTransport(t: SandboxTransport | undefined): SandboxTransport | undefined {
  const prev = transport;
  transport = t;
  return prev;
}

/** Close the current transport (the default worker) and forget it; the next render starts a fresh one. */
export async function closeSandbox(): Promise<void> {
  const t = transport;
  transport = undefined;
  await t?.close();
}
