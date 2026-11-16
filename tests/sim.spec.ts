// The simulated victim's stores and browser (src/core/sim/): inbox, attacker log, cookie jar, SimBrowser.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import net, { createConnection } from 'node:net';
import ts from 'typescript';
import { afterAll, describe, it, expect, onTestFinished, vi } from 'vitest';
import {
  CAPPED_BUDGET_BYTES, NewSessionLimitError, cappedBudgetUsage, insidePerSessionFactory, perSession, setCappedBudget, setPerSessionDefaults,
} from '../src/core/lab.js';
import type { Level } from '../src/core/levels.js';
import type { Request } from 'express';
import {
  ADMIN_MAILBOX, PLAYER_MAILBOX, SIM_LIMITS, SIM_USER_AGENT, VICTIM_LABELS, attackerLog, checkMailAction, classifySimUrl, sendLinkAction, simInbox, simWorld,
  type SimHandler, type SimRequest, type SimResponse, type SimWorld,
} from '../src/core/sim.js';

let n = 0;
/** Build sim state the way labs must: inside a perSession factory (one fresh session per call). */
function inSession<T>(make: () => T, level: Level = 'acolyte'): T {
  return perSession(() => make()).for({ sessionId: `sim-${++n}`, level });
}
/** A full GC: vitest.config.ts starts the test workers with --expose-gc (poolOptions.forks.execArgv). */
function fullGc(): () => void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('globalThis.gc is missing: run the specs with --expose-gc (vitest.config.ts)');
  return gc;
}

/** What one simWorld() weighs in the shared budget: its inbox, its attacker log and its own visits. */
const WORLD = SIM_LIMITS.inboxWeight + SIM_LIMITS.attackerLogWeight + SIM_LIMITS.visitsWeight;

/** A world whose clock tests can move (world.now = ...). */
const world = (mailboxes: readonly string[] = [ADMIN_MAILBOX]): SimWorld => inSession(() => simWorld({ mailboxes }));

/** A handler from a route table: path -> response (or a function of the request). Records every request. */
function site(routes: Record<string, SimResponse | ((r: SimRequest) => SimResponse)>) {
  const seen: SimRequest[] = [];
  const handler: SimHandler = (r) => {
    seen.push(r);
    const route = routes[r.path];
    if (route === undefined) return { status: 404, body: 'Not found' };
    return typeof route === 'function' ? route(r) : route;
  };
  return { handler, seen };
}
const redirect = (location: string, status = 302, extra: Record<string, string | string[]> = {}): SimResponse =>
  ({ status, headers: { location, ...extra } });

// Every TCP connection (http, https, http2, tls, fetch/undici, net) goes through net.Socket.prototype.connect: this
// whole file runs with it spied, and nothing in it may open one.
const socketConnect = vi.spyOn(net.Socket.prototype, 'connect');
afterAll(() => {
  const calls = socketConnect.mock.calls.length;
  socketConnect.mockRestore();
  expect(calls, 'a socket was opened while the sim specs ran').toBe(0);
});

/** The pure simulation: every module in src/core/sim/ (the engine side, core/victim.ts, is Express integration). */
const SIM_DIR = new URL('../src/core/sim/', import.meta.url);
const SIM_FILES = readdirSync(SIM_DIR).filter((f) => f.endsWith('.ts')).sort();
/** Runtime imports those modules may have; type-only imports are erased. Anything else fails the guard. */
const SIM_ALLOWED_IMPORTS: ReadonlySet<string> = new Set(['node:buffer', '../lab.js', ...SIM_FILES.map((f) => `./${f.replace(/\.ts$/, '.js')}`)]);
/** Globals that reach the network or load code, however the call site spells the rest. */
const SIM_DENIED_GLOBALS: ReadonlySet<string> = new Set([
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'globalThis', 'global', 'window', 'self', 'process', 'require',
  'module', 'eval', 'Function', 'Deno', 'Bun',
]);

/** A module's runtime imports, and what it must never do (dynamic import, require, a denied global), parsed by tsc. */
function simSourceCheck(src: string): { runtime: string[]; problems: string[] } {
  const sf = ts.createSourceFile('sim.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
    } else if (ts.isIdentifier(node) && SIM_DENIED_GLOBALS.has(node.text)) {
      problems.push(`${node.text} (line ${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { runtime, problems };
}

describe('sim state lives in perSession (per player and level)', () => {
  it('every sim store refuses to be created outside a perSession factory', () => {
    expect(() => simWorld()).toThrow(/perSession/);
    expect(() => simInbox()).toThrow(/perSession/);
    expect(() => attackerLog()).toThrow(/perSession/);
    const w = world();
    expect(() => w.browser(() => ({ status: 200 }))).toThrow(/perSession/);
  });

  it('insidePerSessionFactory() is true only while a factory runs, even when the factory throws', () => {
    expect(insidePerSessionFactory()).toBe(false);
    let during = false;
    perSession(() => { during = insidePerSessionFactory(); return {}; }).for({ sessionId: 's', level: 'acolyte' });
    expect(during).toBe(true);
    expect(insidePerSessionFactory()).toBe(false);
    expect(() => perSession(() => { throw new Error('boom'); }).for({ sessionId: 's', level: 'acolyte' })).toThrow('boom');
    expect(insidePerSessionFactory()).toBe(false);
  });

  it('isolates sessions and levels; reset gives a fresh world', () => {
    const labs = perSession(() => simWorld({ mailboxes: [ADMIN_MAILBOX] }));
    const a = { sessionId: 'A', level: 'acolyte' as Level };
    labs.for(a).inbox.deliver({ from: 'x@citadel.test', to: PLAYER_MAILBOX, subject: 'only A', body: '' });
    labs.for(a).attackerLog.record({ method: 'GET', url: 'http://attacker.test/a' });
    expect(labs.for({ sessionId: 'B', level: 'acolyte' }).inbox.list(PLAYER_MAILBOX)).toEqual([]);
    expect(labs.for({ sessionId: 'A', level: 'templar' }).inbox.list(PLAYER_MAILBOX)).toEqual([]);
    expect(labs.for({ sessionId: 'A', level: 'templar' }).attackerLog.entries()).toEqual([]);
    expect(labs.for(a).inbox.list(PLAYER_MAILBOX)).toHaveLength(1);
    labs.reset(a);
    expect(labs.for(a).inbox.list(PLAYER_MAILBOX)).toEqual([]);
    expect(labs.for(a).attackerLog.entries()).toEqual([]);
  });

  it('inherits the holder\'s new-instance limit', () => {
    const labs = perSession(() => simWorld(), { maxNewPerMinute: 2, now: () => 0 });
    labs.for({ sessionId: '1', level: 'acolyte' });
    labs.for({ sessionId: '2', level: 'acolyte' });
    expect(() => labs.for({ sessionId: '3', level: 'acolyte' })).toThrow(NewSessionLimitError);
  });

  it('every sim store weighs its measured worst case: a world is its inbox + attacker log + visits, a browser its jar', () => {
    const KiB = 1024;
    expect([SIM_LIMITS.inboxWeight, SIM_LIMITS.attackerLogWeight, SIM_LIMITS.visitsWeight, SIM_LIMITS.browserWeight])
      .toEqual([576 * KiB, 416 * KiB, 288 * KiB, 224 * KiB]);
    const before = cappedBudgetUsage().bytes;
    const lab = perSession(() => { const w = simWorld(); return { w, b: w.browser(() => ({ status: 200 })) }; });
    lab.for({ sessionId: 'weigh', level: 'acolyte' });
    expect(cappedBudgetUsage().bytes - before).toBe(WORLD + SIM_LIMITS.browserWeight); // 1.25 MiB + 224 KiB
    lab.reset({ sessionId: 'weigh', level: 'acolyte' });
    expect(cappedBudgetUsage().bytes).toBe(before);
  });

  it('every holder that keeps sim state shares ONE byte budget, process-wide (CAPPED_BUDGET_BYTES, 96 MiB)', () => {
    expect(cappedBudgetUsage().budget).toBe(CAPPED_BUDGET_BYTES);
    const prev = setCappedBudget(10 * WORLD); // ten worlds' worth, for a short test
    onTestFinished(() => { setCappedBudget(prev); });
    const r = (sessionId: string) => ({ sessionId, level: 'acolyte' as Level });
    const worlds = perSession(() => ({ world: simWorld() })); // two labs' holders...
    const inboxes = perSession(() => simInbox()); // ...every sim store counts, not only the world
    const plain = perSession((_l, sid) => ({ sid }));
    for (let i = 0; i < 12; i++) worlds.for(r(`w${i}`));
    expect(worlds.size).toBe(10);
    for (let i = 0; i < 5; i++) { inboxes.for(r(`i${i}`)); plain.for(r(`p${i}`)); }
    // 5 inboxes need 5 x 576 KiB: the three least recently used worlds (1.25 MiB each) make room, in the other holder.
    expect([worlds.size, inboxes.size, plain.size]).toEqual([7, 5, 5]);
    expect(cappedBudgetUsage().bytes).toBeLessThanOrEqual(10 * WORLD);
    const fewer = perSession(() => simWorld(), { maxEntries: 3 }); // a lab may still keep fewer
    for (let i = 0; i < 6; i++) fewer.for(r(`f${i}`));
    expect(fewer.size).toBe(3);
  });

  it('an instance evicted by the budget comes back fresh on its next use (eviction is a reset)', () => {
    const prev = setCappedBudget(2 * WORLD);
    onTestFinished(() => { setCappedBudget(prev); });
    const labs = perSession(() => simWorld());
    const a = { sessionId: 'A', level: 'acolyte' as Level };
    labs.for(a).inbox.deliver({ from: 'x@citadel.test', to: PLAYER_MAILBOX, subject: 'kept?', body: '' });
    labs.for({ sessionId: 'B', level: 'acolyte' });
    labs.for({ sessionId: 'C', level: 'acolyte' }); // evicts A, the least recently used
    expect(labs.size).toBe(2);
    expect(labs.for(a).inbox.list(PLAYER_MAILBOX)).toEqual([]);
  });

  it(`creates at most ${SIM_LIMITS.newWorldsPerMinute} new instances a minute by default; a lab may set fewer`, () => {
    expect(SIM_LIMITS.newWorldsPerMinute).toBe(30);
    const prev = setPerSessionDefaults({ maxNewPerMinute: 120 }); // the engine default (tests lift it to Infinity)
    onTestFinished(() => { setPerSessionDefaults(prev); });
    let t = 0;
    const labs = perSession(() => simWorld(), { now: () => t });
    for (let i = 0; i < SIM_LIMITS.newWorldsPerMinute; i++) labs.for({ sessionId: `n${i}`, level: 'acolyte' });
    expect(() => labs.for({ sessionId: 'one-more', level: 'acolyte' })).toThrow(NewSessionLimitError);
    t = 60_000;
    expect(() => labs.for({ sessionId: 'one-more', level: 'acolyte' })).not.toThrow();
  });

  it('fails fast, at the first factory run, when the lab asks for a faster rate (entries: the shared budget bounds them)', () => {
    const req = { sessionId: 'x', level: 'acolyte' as Level };
    const fast = perSession(() => ({ world: simWorld() }), { maxNewPerMinute: SIM_LIMITS.newWorldsPerMinute + 1 });
    expect(() => fast.for(req)).toThrow(/simWorld: .*at most 30 new.*maxNewPerMinute: 31/);
    expect(fast.size).toBe(0);
    expect(() => perSession(() => simWorld(), { maxNewPerMinute: Infinity }).for(req)).toThrow(/simWorld: .*at most 30 new/);
    expect(() => perSession(() => simInbox(), { maxNewPerMinute: 1000 }).for(req)).toThrow(/simInbox: .*at most 30 new/);
    expect(perSession(() => simWorld(), { maxEntries: 5000, maxNewPerMinute: 30 }).for(req)).toBeDefined();
  });

});

describe('simInbox: mailboxes keyed by address', () => {
  it('always has the player\'s mailbox (pilgrim@citadel.test), plus the ones the lab names', () => {
    expect(PLAYER_MAILBOX).toBe('pilgrim@citadel.test');
    expect(inSession(() => simInbox()).addresses).toEqual([PLAYER_MAILBOX]);
    const inbox = inSession(() => simInbox({ mailboxes: [' Citadel_Admin@CITADEL.test ', PLAYER_MAILBOX] }));
    expect(inbox.addresses).toEqual([PLAYER_MAILBOX, ADMIN_MAILBOX]);
  });

  it('delivers with an id and the clock\'s time; lists newest first; addresses match case-insensitively', () => {
    let t = 1_000;
    const inbox = inSession(() => simInbox({ mailboxes: [ADMIN_MAILBOX], now: () => t }));
    const first = inbox.deliver({ from: 'noreply@citadel.test', to: 'CITADEL_ADMIN@citadel.test', subject: 'one', body: 'b1', links: ['http://citadel.test/1'] });
    t = 2_000;
    const second = inbox.deliver({ from: 'noreply@citadel.test', to: ADMIN_MAILBOX, subject: 'two', body: 'b2' });
    expect(first).toMatchObject({ id: 1, at: 1_000, to: ADMIN_MAILBOX, subject: 'one', links: ['http://citadel.test/1'] });
    expect(second).toMatchObject({ id: 2, at: 2_000, links: [] });
    expect(inbox.list(ADMIN_MAILBOX).map((m) => m.subject)).toEqual(['two', 'one']);
    expect(inbox.newest(' citadel_admin@citadel.test')?.subject).toBe('two');
    expect(inbox.list(PLAYER_MAILBOX)).toEqual([]);
    expect(inbox.newest(PLAYER_MAILBOX)).toBeUndefined();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.links)).toBe(true);
  });

  it('mail to an unknown address bounces (undefined) and stores nothing', () => {
    const inbox = inSession(() => simInbox());
    expect(inbox.deliver({ from: 'a@b', to: 'nobody@citadel.test', subject: 's', body: 'b' })).toBeUndefined();
    expect(inbox.has('nobody@citadel.test')).toBe(false);
    expect(inbox.list('nobody@citadel.test')).toEqual([]);
    expect(inbox.list('__proto__')).toEqual([]);
  });

  it(`keeps at most ${SIM_LIMITS.mailsPerMailbox} mails per mailbox (oldest dropped), independently per mailbox`, () => {
    const inbox = inSession(() => simInbox({ mailboxes: [ADMIN_MAILBOX] }));
    inbox.deliver({ from: 'x', to: ADMIN_MAILBOX, subject: 'admin keeps this', body: '' });
    for (let i = 0; i < SIM_LIMITS.mailsPerMailbox + 5; i++) inbox.deliver({ from: 'x', to: PLAYER_MAILBOX, subject: `m${i}`, body: '' });
    const mine = inbox.list(PLAYER_MAILBOX);
    expect(mine).toHaveLength(SIM_LIMITS.mailsPerMailbox);
    expect(mine[0].subject).toBe(`m${SIM_LIMITS.mailsPerMailbox + 4}`);
    expect(mine.at(-1)?.subject).toBe('m5');
    expect(inbox.list(ADMIN_MAILBOX).map((m) => m.subject)).toEqual(['admin keeps this']);
  });

  it('clips long fields and keeps at most a few links (non-strings dropped; an over-long link stays too long to follow)', () => {
    const inbox = inSession(() => simInbox());
    const m = inbox.deliver({
      from: 'f'.repeat(1000), to: PLAYER_MAILBOX, subject: 's'.repeat(1000), body: 'b'.repeat(100_000),
      links: ['http://citadel.test/1', 42 as never, 'http://citadel.test/2', `http://attacker.test/${'x'.repeat(10_000)}`, 'http://citadel.test/4'],
    });
    expect(m?.from.length).toBe(SIM_LIMITS.addressLength);
    expect(m?.subject.length).toBe(SIM_LIMITS.subjectLength);
    expect(m?.body.length).toBe(SIM_LIMITS.bodyLength);
    expect(m?.links).toHaveLength(SIM_LIMITS.linksPerMail);
    expect(m?.links.slice(0, 2)).toEqual(['http://citadel.test/1', 'http://citadel.test/2']);
    expect(m?.links[2].length).toBe(SIM_LIMITS.urlLength + 1);
  });

  it('non-string fields are empty strings, never a throw', () => {
    const inbox = inSession(() => simInbox());
    const m = inbox.deliver({ from: {} as never, to: PLAYER_MAILBOX, subject: undefined as never, body: 5 as never, links: 'x' as never });
    expect(m).toMatchObject({ from: '', subject: '', body: '', links: [] });
  });

  it(`refuses bad mailbox lists: more than ${SIM_LIMITS.mailboxes} (the player's included), or an address that is not one`, () => {
    expect(SIM_LIMITS.mailboxes).toBe(3); // the player's, the admin's, and one spare
    expect(inSession(() => simInbox({ mailboxes: [ADMIN_MAILBOX, 'other@citadel.test'] })).addresses).toHaveLength(3);
    expect(() => inSession(() => simInbox({ mailboxes: [ADMIN_MAILBOX, 'a@citadel.test', 'b@citadel.test'] }))).toThrow(/at most 3 mailboxes/);
    const many = Array.from({ length: SIM_LIMITS.mailboxes }, (_, i) => `u${i}@citadel.test`);
    expect(() => inSession(() => simInbox({ mailboxes: many }))).toThrow(/mailboxes/);
    expect(() => inSession(() => simInbox({ mailboxes: ['no-at-sign'] }))).toThrow(/address/);
    expect(() => inSession(() => simInbox({ mailboxes: [`${'a'.repeat(300)}@citadel.test`] }))).toThrow(/address/);
  });
});

describe('attackerLog: append-only, capped', () => {
  it('records method, URL, Referer and body with a sequence number and the clock\'s time', () => {
    let t = 5;
    const log = inSession(() => attackerLog({ now: () => t }));
    const a = log.record({ method: 'GET', url: 'http://attacker.test/a', referer: 'http://citadel.test/x' });
    t = 6;
    const b = log.record({ method: 'POST', url: 'http://attacker.test/b', body: 'code=1' });
    expect(a).toEqual({ seq: 1, at: 5, method: 'GET', url: 'http://attacker.test/a', referer: 'http://citadel.test/x' });
    expect(b).toEqual({ seq: 2, at: 6, method: 'POST', url: 'http://attacker.test/b', body: 'code=1' });
    expect(log.entries()).toEqual([a, b]);
    expect(log.total).toBe(2);
  });

  it('is append-only: frozen entries, a frozen list, and no way to edit or remove', () => {
    const log = inSession(() => attackerLog());
    log.record({ method: 'GET', url: 'http://attacker.test/' });
    const list = log.entries();
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(list[0])).toBe(true);
    expect(() => { (list as unknown as unknown[]).push({}); }).toThrow();
    expect(Object.keys(log).sort()).toEqual(['entries', 'record', 'total']);
  });

  it(`keeps the newest ${SIM_LIMITS.logEntries} entries; sequence numbers keep counting`, () => {
    const log = inSession(() => attackerLog());
    for (let i = 1; i <= SIM_LIMITS.logEntries + 7; i++) log.record({ method: 'GET', url: `http://attacker.test/${i}` });
    const list = log.entries();
    expect(list).toHaveLength(SIM_LIMITS.logEntries);
    expect(list[0].seq).toBe(8);
    expect(list.at(-1)?.seq).toBe(SIM_LIMITS.logEntries + 7);
    expect(log.total).toBe(SIM_LIMITS.logEntries + 7);
  });

  it('clips URL, Referer and body to the URL length cap', () => {
    const log = inSession(() => attackerLog());
    const big = 'x'.repeat(10_000);
    const e = log.record({ method: 'GET'.repeat(10), url: big, referer: big, body: big });
    expect(e.url.length).toBe(SIM_LIMITS.urlLength);
    expect(e.referer?.length).toBe(SIM_LIMITS.urlLength);
    expect(e.body?.length).toBe(SIM_LIMITS.urlLength);
    expect(e.method.length).toBeLessThanOrEqual(10);
  });
});

describe('SimBrowser: requests to the citadel go to the lab\'s in-process handler', () => {
  it('a GET page: the handler sees method, URL, path, query, headers and cookies; the visit ends on that page', () => {
    const w = world();
    const s = site({ '/home': { status: 200, body: 'Welcome home' } });
    const b = inSession(() => w.browser(s.handler));
    const v = b.follow('http://citadel.test/home?x=1&x=2&y=%20');
    expect(v.outcome).toBe('page');
    expect(v.page).toEqual({ url: 'http://citadel.test/home?x=1&x=2&y=%20', status: 200, body: 'Welcome home' });
    expect(v.hops).toEqual([{ site: 'citadel', method: 'GET', url: 'http://citadel.test/home?x=1&x=2&y=%20', via: 'start', status: 200 }]);
    const r = s.seen[0];
    expect(r).toMatchObject({ method: 'GET', url: 'http://citadel.test/home?x=1&x=2&y=%20', path: '/home' });
    expect(r.query.getAll('x')).toEqual(['1', '2']);
    expect(r.query.get('y')).toBe(' ');
    expect(r.headers).toEqual({ host: 'citadel.test', 'user-agent': SIM_USER_AGENT });
    expect({ ...r.cookies }).toEqual({});
    expect({ ...r.body }).toEqual({});
    expect(w.attackerLog.entries()).toEqual([]);
  });

  it('never calls the handler for attacker.test or other hosts', () => {
    const w = world();
    const s = site({});
    const b = inSession(() => w.browser(s.handler));
    b.follow('http://attacker.test/x');
    b.follow('http://127.0.0.1/');
    b.follow('javascript:alert(1)');
    expect(s.seen).toEqual([]);
  });

  it('a handler must answer synchronously with a valid status', () => {
    const w = world();
    const bad = [
      () => Promise.resolve({ status: 200 }) as never,
      () => ({ status: 99 }), () => ({ status: 600 }), () => ({ status: 200.5 }), () => ({ status: Number.NaN }),
      () => null as never, () => ({ status: 200, body: 5 as never }),
    ];
    for (const h of bad) {
      const b = inSession(() => w.browser(h));
      expect(() => b.follow('http://citadel.test/'), String(h)).toThrow(/SimHandler/);
    }
  });
});

describe('SimBrowser: attacker.test requests land in the player\'s attacker log', () => {
  it('a link straight to attacker.test: logged (no Referer from a mail client), the visit ends there', () => {
    const w = world();
    w.now = () => 42;
    const b = inSession(() => w.browser(site({}).handler));
    const v = b.follow('http://user:pw@evil.attacker.test:8080/steal?token=abc#frag');
    expect(v.outcome).toBe('attacker');
    expect(v.hops).toEqual([{ site: 'attacker', method: 'GET', url: 'http://evil.attacker.test:8080/steal?token=abc', via: 'start' }]);
    expect(w.attackerLog.entries()).toEqual([{ seq: 1, at: 42, method: 'GET', url: 'http://evil.attacker.test:8080/steal?token=abc' }]);
  });

  it('other hosts are unreachable: nothing logged, the reason is in the trace', () => {
    const w = world();
    const b = inSession(() => w.browser(site({}).handler));
    for (const [u, reason] of [['javascript:alert(1)', 'scheme'], ['http://[::1]/', 'ip'], ['http://localhost/', 'host'], ['http://citadel.test:8080/', 'port'], ['nope', 'invalid'], [`http://attacker.test/${'a'.repeat(3000)}`, 'too-long']] as const) {
      const v = b.follow(u);
      expect(v.outcome, u).toBe('unreachable');
      expect(v.hops, u).toHaveLength(1);
      expect(v.hops[0], u).toMatchObject({ site: 'other', reason, via: 'start' });
      expect(v.hops[0].url.length, u).toBeLessThanOrEqual(SIM_LIMITS.urlLength);
    }
    expect(w.attackerLog.entries()).toEqual([]);
  });
});

describe('SimBrowser: redirects and Referer', () => {
  it('follows a 3xx chain; a redirect keeps the referrer of the page that started the navigation (none from mail)', () => {
    const w = world();
    const s = site({ '/a': redirect('/b'), '/b': redirect('http://attacker.test/x?code=1', 301) });
    const b = inSession(() => w.browser(s.handler));
    const v = b.follow('http://citadel.test/a?secret=1');
    expect(v.outcome).toBe('attacker');
    expect(v.hops.map((h) => [h.site, h.via, h.status])).toEqual([['citadel', 'start', 302], ['citadel', 'redirect', 301], ['attacker', 'redirect', undefined]]);
    expect(s.seen.map((r) => r.headers.referer)).toEqual([undefined, undefined]);
    expect(w.attackerLog.entries()[0]).not.toHaveProperty('referer'); // the redirecting URL is not a page: it is not the Referer
  });

  it('a link clicked on a citadel page sends that page as Referer, and keeps it across redirects', () => {
    const w = world();
    const s = site({ '/go': redirect('http://attacker.test/x') });
    const b = inSession(() => w.browser(s.handler));
    b.follow('http://citadel.test/go?to=x', { referrer: 'http://citadel.test/messages?id=7#top' });
    expect(s.seen[0].headers.referer).toBe('http://citadel.test/messages?id=7');
    expect(w.attackerLog.entries()[0].referer).toBe('http://citadel.test/messages?id=7');
  });

  it('a citadel PAGE that moves on by itself (Refresh) sends its own URL as Referer: the classic code leak', () => {
    const w = world();
    const s = site({
      '/callback': (r) => ({ status: 200, headers: { Refresh: `0; url=${r.query.get('next') ?? '/'}` }, body: 'Signed in' }),
    });
    const b = inSession(() => w.browser(s.handler));
    const v = b.follow('http://citadel.test/callback?code=SECRET&next=http://attacker.test/landing');
    expect(v.outcome).toBe('attacker');
    expect(v.hops.map((h) => h.via)).toEqual(['start', 'refresh']);
    expect(w.attackerLog.entries()[0]).toMatchObject({
      url: 'http://attacker.test/landing',
      referer: 'http://citadel.test/callback?code=SECRET&next=http://attacker.test/landing',
    });
  });

  it('Refresh syntax: delay then ";" or ",", optional url= (any case), optional quotes, relative URLs; none = no navigation', () => {
    const w = world();
    for (const value of ['0;url=/next', '5; URL=\'/next\'', '0, url="/next"', '0;   /next', '3;Url=/next']) {
      const s = site({ '/p': { status: 200, headers: { refresh: value } }, '/next': { status: 200, body: 'next' } });
      const v = inSession(() => w.browser(s.handler)).follow('http://citadel.test/p');
      expect(v.outcome, value).toBe('page');
      expect(v.page?.url, value).toBe('http://citadel.test/next');
      expect(s.seen[1].headers.referer, value).toBe('http://citadel.test/p');
    }
    for (const value of ['0', '5;', 'garbage', '']) {
      const s = site({ '/p': { status: 200, headers: { refresh: value } } });
      const v = inSession(() => w.browser(s.handler)).follow('http://citadel.test/p');
      expect(v.hops, value).toHaveLength(1);
      expect(v.outcome, value).toBe('page');
    }
  });

  it('Referrer-Policy on the page decides what the next hop gets; default is the full URL (legacy no-referrer-when-downgrade)', () => {
    const cases: [string | undefined, string | undefined, string | undefined][] = [
      // policy, Referer at attacker.test, Referer at a citadel page
      [undefined, 'http://citadel.test/p?k=1', 'http://citadel.test/p?k=1'],
      ['no-referrer', undefined, undefined],
      ['origin', 'http://citadel.test/', 'http://citadel.test/'],
      ['strict-origin', 'http://citadel.test/', 'http://citadel.test/'],
      ['same-origin', undefined, 'http://citadel.test/p?k=1'],
      ['origin-when-cross-origin', 'http://citadel.test/', 'http://citadel.test/p?k=1'],
      ['strict-origin-when-cross-origin', 'http://citadel.test/', 'http://citadel.test/p?k=1'],
      ['unsafe-url', 'http://citadel.test/p?k=1', 'http://citadel.test/p?k=1'],
      ['no-referrer-when-downgrade', 'http://citadel.test/p?k=1', 'http://citadel.test/p?k=1'],
      ['unsafe-url, bogus', 'http://citadel.test/p?k=1', 'http://citadel.test/p?k=1'], // unknown tokens are ignored
      ['no-referrer, ORIGIN', 'http://citadel.test/', 'http://citadel.test/'],      // the last valid one wins
    ];
    for (const [policy, toAttacker, toCitadel] of cases) {
      const page = (next: string): SimResponse => ({ status: 200, headers: { refresh: `0;url=${next}`, ...(policy ? { 'referrer-policy': policy } : {}) } });
      const w = world();
      inSession(() => w.browser(site({ '/p': page('http://attacker.test/a') }).handler)).follow('http://citadel.test/p?k=1');
      expect(w.attackerLog.entries()[0]?.referer, `${policy} -> attacker`).toBe(toAttacker);
      const s = site({ '/p': page('/q'), '/q': { status: 200 } });
      inSession(() => world().browser(s.handler)).follow('http://citadel.test/p?k=1');
      expect(s.seen[1].headers.referer, `${policy} -> citadel`).toBe(toCitadel);
    }
  });

  it('a Referrer-Policy on a redirect response applies to the next hop', () => {
    const w = world();
    const s = site({ '/go': redirect('http://attacker.test/x', 302, { 'Referrer-Policy': 'no-referrer' }) });
    inSession(() => w.browser(s.handler)).follow('http://citadel.test/go', { referrer: 'http://citadel.test/inbox' });
    expect(w.attackerLog.entries()[0]).not.toHaveProperty('referer');
  });

  it('https -> http is a downgrade: no Referer under the default policy', () => {
    const w = world();
    const s = site({ '/p': { status: 200, headers: { refresh: '0;url=http://attacker.test/a' } } });
    inSession(() => w.browser(s.handler)).follow('https://citadel.test/p?k=1');
    expect(w.attackerLog.entries()[0]).not.toHaveProperty('referer');
  });

  it('the Referer never carries userinfo or a fragment', () => {
    const w = world();
    const s = site({ '/p': { status: 200, headers: { refresh: '0;url=http://attacker.test/a' } } });
    inSession(() => w.browser(s.handler)).follow('http://admin:pw@citadel.test/p?k=1#frag');
    expect(w.attackerLog.entries()[0].referer).toBe('http://citadel.test/p?k=1');
  });

  it('a referrer must be a citadel page (the victim never browses from your server)', () => {
    const w = world();
    const b = inSession(() => w.browser(site({}).handler));
    expect(() => b.follow('http://citadel.test/', { referrer: 'http://attacker.test/page' })).toThrow(/referrer/);
    expect(() => b.follow('http://citadel.test/', { referrer: 'javascript:1' })).toThrow(/referrer/);
  });

  it('nothing comes from attacker.test: the visit ends at the first attacker request', () => {
    const w = world();
    const s = site({ '/a': redirect('http://attacker.test/1') });
    const v = inSession(() => w.browser(s.handler)).follow('http://citadel.test/a');
    expect(v.hops.at(-1)?.site).toBe('attacker');
    expect(w.attackerLog.entries()).toHaveLength(1);
    expect(s.seen).toHaveLength(1);
  });

  it(`stops after ${SIM_LIMITS.maxRedirects} redirects (too-many-redirects); exactly ${SIM_LIMITS.maxRedirects} is fine`, () => {
    const w = world();
    const endless = (r: SimRequest): SimResponse => redirect(`/n${Number(r.path.slice(2)) + 1}`);
    const s = { handler: (r: SimRequest) => endless(r) };
    const v = inSession(() => w.browser(s.handler)).follow('http://citadel.test/n0');
    expect(v.outcome).toBe('too-many-redirects');
    expect(v.hops).toHaveLength(SIM_LIMITS.maxRedirects + 1);
    const ten = (r: SimRequest): SimResponse => {
      const i = Number(r.path.slice(2));
      return i < SIM_LIMITS.maxRedirects ? redirect(`/n${i + 1}`) : { status: 200, body: 'done' };
    };
    const ok = inSession(() => w.browser(ten)).follow('http://citadel.test/n0');
    expect(ok.outcome).toBe('page');
    expect(ok.hops).toHaveLength(SIM_LIMITS.maxRedirects + 1);
  });

  it('detects a loop (the same request again with nothing changed) before re-requesting it', () => {
    const w = world();
    const s = site({ '/a': redirect('/b'), '/b': redirect('/a') });
    const v = inSession(() => w.browser(s.handler)).follow('http://citadel.test/a');
    expect(v.outcome).toBe('loop');
    expect(s.seen.map((r) => r.path)).toEqual(['/a', '/b']);
    const self = site({ '/s': redirect('') }); // an empty Location is the same URL again
    expect(inSession(() => w.browser(self.handler)).follow('http://citadel.test/s').outcome).toBe('loop');
    const refresh = site({ '/r': { status: 200, headers: { refresh: '0;url=/r' } } });
    expect(inSession(() => w.browser(refresh.handler)).follow('http://citadel.test/r').outcome).toBe('loop');
  });

  it('a sign-in bounce that sets a cookie is not a loop', () => {
    const w = world();
    const s = site({
      '/private': (r) => (r.cookies.sid === 'ok' ? { status: 200, body: 'private' } : redirect('/login')),
      '/login': redirect('/private', 302, { 'set-cookie': 'sid=ok; Path=/' }),
    });
    const v = inSession(() => w.browser(s.handler)).follow('http://citadel.test/private');
    expect(v.outcome).toBe('page');
    expect(v.page?.body).toBe('private');
    expect(s.seen.map((r) => r.path)).toEqual(['/private', '/login', '/private']);
  });

  it('a Location that leaves the sim is unreachable; relative Locations resolve against the current URL', () => {
    const w = world();
    const s = site({ '/a': redirect('http://169.254.169.254/latest'), '/dir/b': redirect('c'), '/dir/c': { status: 200 }, '/long': redirect(`/${'x'.repeat(5000)}`) });
    const b = inSession(() => w.browser(s.handler));
    expect(b.follow('http://citadel.test/a')).toMatchObject({ outcome: 'unreachable' });
    expect(b.follow('http://citadel.test/a').hops[1]).toMatchObject({ site: 'other', reason: 'ip', via: 'redirect' });
    expect(b.follow('http://citadel.test/dir/b').page?.url).toBe('http://citadel.test/dir/c');
    const long = b.follow('http://citadel.test/long');
    expect(long.outcome).toBe('unreachable');
    expect(long.hops[1]).toMatchObject({ reason: 'too-long' });
    expect(long.hops[1].url.length).toBeLessThanOrEqual(SIM_LIMITS.urlLength);
  });

  it('follows Location only on 301, 302, 303, 307 and 308 (Fetch); with any other status it is a page', () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const s = site({ '/a': { status, headers: { location: '/b' } }, '/b': { status: 200 } });
      const v = inSession(() => world().browser(s.handler)).follow('http://citadel.test/a');
      expect(v.page?.url, String(status)).toBe('http://citadel.test/b');
    }
    for (const status of [300, 304, 305, 306, 399, 200, 201, 404, 500]) {
      const s = site({ '/a': { status, headers: { location: '/b' } }, '/b': { status: 200 } });
      const v = inSession(() => world().browser(s.handler)).follow('http://citadel.test/a');
      expect(v, String(status)).toMatchObject({ outcome: 'page', page: { url: 'http://citadel.test/a', status } });
      expect(s.seen, String(status)).toHaveLength(1);
    }
  });

  it('a 3xx that is not followed is a page: its Refresh moves the browser on, sending the page as Referer', () => {
    for (const headers of [{ refresh: '0;url=http://attacker.test/x' }, { location: '/b', refresh: '0;url=http://attacker.test/x' }]) {
      const w = world();
      const status = 'location' in headers ? 300 : 302;
      const v = inSession(() => w.browser(site({ '/a': { status, headers } }).handler)).follow('http://citadel.test/a?k=1');
      expect(v.hops.map((h) => [h.via, h.status]), String(status)).toEqual([['start', status], ['refresh', undefined]]);
      expect(w.attackerLog.entries()[0].referer, String(status)).toBe('http://citadel.test/a?k=1');
    }
    // A redirect that IS followed is not a page: its Refresh is never used.
    const w = world();
    const s = site({ '/a': { status: 302, headers: { location: '/b', refresh: '0;url=http://attacker.test/x' } }, '/b': { status: 200 } });
    expect(inSession(() => w.browser(s.handler)).follow('http://citadel.test/a').page?.url).toBe('http://citadel.test/b');
    expect(w.attackerLog.entries()).toEqual([]);
  });

  it('header names are case-insensitive; a 3xx without Location is a page', () => {
    const w = world();
    const s = site({ '/a': { status: 302, headers: { LOCATION: '/b' } }, '/b': { status: 304 } });
    const v = inSession(() => w.browser(s.handler)).follow('http://citadel.test/a');
    expect(v).toMatchObject({ outcome: 'page', page: { url: 'http://citadel.test/b', status: 304, body: '' } });
  });
});

describe('SimBrowser: form posts', () => {
  it('submit() POSTs a form; 303 (and 301/302) continue as GET without the body; 307/308 keep POST and body', () => {
    for (const [status, method] of [[303, 'GET'], [302, 'GET'], [301, 'GET'], [307, 'POST'], [308, 'POST']] as const) {
      const w = world();
      const s = site({ '/login': redirect('/home', status), '/home': { status: 200 } });
      const v = inSession(() => w.browser(s.handler)).submit('http://citadel.test/login', { username: 'citadel_admin', password: 'p w&' });
      expect(v.outcome).toBe('page');
      expect(s.seen[0]).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      expect({ ...s.seen[0].body }).toEqual({ username: 'citadel_admin', password: 'p w&' });
      expect(s.seen[1].method, String(status)).toBe(method);
      expect({ ...s.seen[1].body }, String(status)).toEqual(method === 'POST' ? { username: 'citadel_admin', password: 'p w&' } : {});
      expect(v.hops.map((h) => h.method)).toEqual(['POST', method]);
    }
  });

  it('a POST forwarded to attacker.test (307) is logged with its body', () => {
    const w = world();
    const s = site({ '/send': redirect('http://attacker.test/collect', 307) });
    inSession(() => w.browser(s.handler)).submit('http://citadel.test/send', { code: 'abc', x: '1 2' });
    expect(w.attackerLog.entries()[0]).toMatchObject({ method: 'POST', url: 'http://attacker.test/collect', body: 'code=abc&x=1+2' });
  });

  it('non-string form values are dropped; body objects have no prototype', () => {
    const w = world();
    const s = site({ '/f': { status: 200 } });
    inSession(() => w.browser(s.handler)).submit('http://citadel.test/f', { a: 'x', b: 5 as never, __proto__: 'p' } as never);
    expect(Object.getPrototypeOf(s.seen[0].body)).toBeNull();
    expect(s.seen[0].body.a).toBe('x');
    expect(Object.hasOwn(s.seen[0].body, 'b')).toBe(false);
  });
});

describe('SimBrowser cookie jar (citadel.test only, never real cookies)', () => {
  it('stores Set-Cookie from citadel responses and sends it back (decoded in req.cookies, raw in the Cookie header)', () => {
    const w = world();
    const s = site({
      '/login': { status: 200, headers: { 'set-cookie': ['sid=a%20b; Path=/; HttpOnly; SameSite=Lax', 'theme=dark'] } },
      '/me': { status: 200 },
    });
    const b = inSession(() => w.browser(s.handler));
    b.follow('http://citadel.test/login');
    b.follow('http://citadel.test/me');
    expect(s.seen[1].headers.cookie).toBe('sid=a%20b; theme=dark');
    expect({ ...s.seen[1].cookies }).toEqual({ sid: 'a b', theme: 'dark' });
    expect(Object.getPrototypeOf(s.seen[1].cookies)).toBeNull();
    expect(b.cookies.get('sid')).toBe('a%20b');
    expect(b.cookies.size).toBe(2);
  });

  it('the lab can sign the victim in up front (set), and delete or clear cookies', () => {
    const w = world();
    const s = site({ '/me': { status: 200 } });
    const b = inSession(() => w.browser(s.handler));
    b.cookies.set('idp_session', 'admin-1');
    b.cookies.set('scoped', 'x', { path: '/admin' });
    b.follow('http://citadel.test/me');
    expect(s.seen[0].cookies).toEqual(Object.assign(Object.create(null), { idp_session: 'admin-1' }));
    expect(b.cookies.list().map((c) => [c.name, c.path])).toEqual([['idp_session', '/'], ['scoped', '/admin']]);
    b.cookies.delete('scoped');
    expect(b.cookies.size).toBe(1);
    b.cookies.clear();
    expect(b.cookies.size).toBe(0);
    expect(() => b.cookies.set('bad name', 'x')).toThrow(/cookie/);
  });

  it('is never sent to attacker.test (and the log has no cookie column)', () => {
    const w = world();
    const s = site({ '/go': redirect('http://attacker.test/x', 302, { 'set-cookie': 'sid=secret; Path=/' }) });
    const b = inSession(() => w.browser(s.handler));
    b.cookies.set('idp', 'secret2');
    b.follow('http://citadel.test/go');
    expect(JSON.stringify(w.attackerLog.entries())).not.toMatch(/secret/);
  });

  it('Path: sent only under the cookie path; the default path comes from the request path', () => {
    const w = world();
    const s = site({
      '/admin/login': { status: 200, headers: { 'set-cookie': ['a=1; Path=/admin', 'b=2', 'c=3; Path=relative'] } },
      '/admin': { status: 200 }, '/admin/x': { status: 200 }, '/administrator': { status: 200 }, '/': { status: 200 },
    });
    const b = inSession(() => w.browser(s.handler));
    b.follow('http://citadel.test/admin/login');
    for (const p of ['/admin', '/admin/x', '/administrator', '/']) b.follow(`http://citadel.test${p}`);
    expect(s.seen.slice(1).map((r) => r.headers.cookie)).toEqual(['a=1; b=2; c=3', 'a=1; b=2; c=3', undefined, undefined]);
  });

  it('Max-Age / Expires follow the world clock; Max-Age=0 or a past date deletes', () => {
    const w = world();
    w.now = () => Date.UTC(2026, 0, 1);
    const s = site({
      '/set': { status: 200, headers: { 'set-cookie': ['short=1; Max-Age=60', 'long=2; Expires=Wed, 01 Jan 2031 00:00:00 GMT', 'bad=3; Max-Age=soon'] } },
      '/del': { status: 200, headers: { 'set-cookie': ['long=; Max-Age=0', 'bad=; Expires=Thu, 01 Jan 1970 00:00:00 GMT'] } },
      '/me': { status: 200 },
    });
    const b = inSession(() => w.browser(s.handler));
    b.follow('http://citadel.test/set');
    expect(b.cookies.list().map((c) => c.name)).toEqual(['short', 'long', 'bad']);
    w.now = () => Date.UTC(2026, 0, 1) + 61_000;
    b.follow('http://citadel.test/me');
    expect(s.seen.at(-1)?.headers.cookie).toBe('long=2; bad=3');
    b.follow('http://citadel.test/del');
    expect(b.cookies.list()).toEqual([]);
  });

  it('Domain must be citadel.test; Secure needs https (as browsers enforce)', () => {
    const w = world();
    const cookies = ['a=1; Domain=attacker.test', 'b=2; Domain=citadel.test', 'c=3; Domain=.CITADEL.TEST', 'd=4; Domain=test', 'e=5; Domain=x.citadel.test', 'f=6; Secure'];
    const s = site({ '/set': { status: 200, headers: { 'set-cookie': cookies } }, '/me': { status: 200 } });
    const b = inSession(() => w.browser(s.handler));
    b.follow('http://citadel.test/set');
    expect(b.cookies.list().map((c) => c.name)).toEqual(['b', 'c']);
    b.follow('https://citadel.test/set');
    expect(b.cookies.list().map((c) => c.name)).toEqual(['b', 'c', 'f']);
    b.follow('http://citadel.test/me');
    expect(s.seen.at(-1)?.headers.cookie).toBe('b=2; c=3');
    b.follow('https://citadel.test/me');
    expect(s.seen.at(-1)?.headers.cookie).toBe('b=2; c=3; f=6');
  });

  it('ignores malformed lines and bad names; replaces a cookie with the same name and path', () => {
    const w = world();
    const s = site({ '/set': { status: 200, headers: { 'set-cookie': ['novalue', '=x', 'bad name=1', 'ok=1', 'ok=2', 'semi=a;b'] } } });
    const b = inSession(() => w.browser(s.handler));
    b.follow('http://citadel.test/set');
    expect(b.cookies.list().map((c) => `${c.name}=${c.value}`)).toEqual(['ok=2', 'semi=a']);
  });

  it(`caps: at most ${SIM_LIMITS.cookies} cookies (oldest evicted), each at most ${SIM_LIMITS.cookieBytes} bytes`, () => {
    const w = world();
    const lines = Array.from({ length: SIM_LIMITS.cookies + 5 }, (_, i) => `c${i}=${i}`);
    const s = site({ '/set': { status: 200, headers: { 'set-cookie': [...lines, `big=${'x'.repeat(SIM_LIMITS.cookieBytes)}`] } } });
    const b = inSession(() => w.browser(s.handler));
    b.follow('http://citadel.test/set');
    expect(b.cookies.size).toBe(SIM_LIMITS.cookies);
    expect(b.cookies.list()[0].name).toBe('c5');
    expect(b.cookies.get('big')).toBeUndefined();
    expect(() => b.cookies.set('big', 'x'.repeat(SIM_LIMITS.cookieBytes))).toThrow(/cookie/);
  });
});

describe('SimWorld: the victim\'s recent visits', () => {
  it(`records each visit, newest last, at most ${SIM_LIMITS.visits}`, () => {
    const w = world();
    const b = inSession(() => w.browser(site({ '/p': { status: 200 } }).handler));
    for (let i = 0; i < SIM_LIMITS.visits + 3; i++) b.follow(`http://citadel.test/p?i=${i}`);
    expect(w.visits).toHaveLength(SIM_LIMITS.visits);
    expect(w.visits.at(-1)?.hops[0].url).toBe(`http://citadel.test/p?i=${SIM_LIMITS.visits + 2}`);
  });

  it(`keeps a page body clipped to ${SIM_LIMITS.bodyLength} chars`, () => {
    const w = world();
    const b = inSession(() => w.browser(site({ '/big': { status: 200, body: `${'b'.repeat(100_000)}END` } }).handler));
    const v = b.follow('http://citadel.test/big');
    expect(v.page?.body).toBe('b'.repeat(SIM_LIMITS.bodyLength));
    expect(w.visits[0].page?.body).toBe('b'.repeat(SIM_LIMITS.bodyLength));
  });
});

describe('victim action presets', () => {
  const req = {} as Request; // the presets hand it to the lab's own accessors only
  const noRearm = (): void => {}; // these victims have no standing state to restore
  const mail = (w: SimWorld, to: string, links: string[]) => w.inbox.deliver({ from: 'ops@citadel.test', to, subject: 's', body: 'b', links });

  it('checkMailAction: the victim opens the newest mail in its mailbox and clicks one link (default the first)', () => {
    const w = world();
    const s = site({ '/a': { status: 200 }, '/b': { status: 200 } });
    const b = inSession(() => w.browser(s.handler));
    const first = checkMailAction({ browser: () => b, mailbox: ADMIN_MAILBOX, rearm: noRearm });
    expect(first).toMatchObject({ name: 'check-mail', label: VICTIM_LABELS.checkMail });
    expect(first.input).toBeUndefined();
    expect(first.description?.en).toBe('opens the newest mail and clicks its first link');
    expect(first.description?.id).toBe('membuka surat terbaru dan mengklik tautan pertamanya');
    expect(first.run(req, { url: '' })).toEqual({ id: 'Kotak surat korban kosong.', en: "The victim's mailbox is empty." });
    mail(w, ADMIN_MAILBOX, ['http://citadel.test/old']);
    mail(w, ADMIN_MAILBOX, ['http://citadel.test/a', 'http://citadel.test/b']);
    mail(w, PLAYER_MAILBOX, ['http://citadel.test/mine']);
    expect(first.run(req, { url: '' })).toBeUndefined();
    const second = checkMailAction({ browser: () => b, mailbox: ADMIN_MAILBOX, link: 1, name: 'check-second', rearm: noRearm });
    expect(second.name).toBe('check-second');
    expect(second.description?.en).toBe('opens the newest mail and clicks link 2 in it');
    second.run(req, { url: '' });
    expect(s.seen.map((r) => [r.path, r.headers.referer])).toEqual([['/a', undefined], ['/b', undefined]]); // from a mail client
    const third = checkMailAction({ browser: () => b, mailbox: ADMIN_MAILBOX, link: 2, rearm: noRearm });
    expect(third.run(req, { url: '' })).toEqual({ id: 'Surat terbaru korban tidak punya tautan ke-3.', en: "The victim's newest mail has no link 3." });
    expect(s.seen).toHaveLength(2);
  });

  it('sendLinkAction: the victim opens whatever link the player sent', () => {
    const w = world();
    const s = site({ '/x': { status: 200 } });
    const b = inSession(() => w.browser(s.handler));
    const send = sendLinkAction(() => b, { rearm: noRearm });
    expect(send).toMatchObject({ name: 'send-link', label: VICTIM_LABELS.sendLink, input: 'url' });
    expect(send.description?.en).toBe('opens any link you send');
    expect(send.run(req, { url: 'http://citadel.test/x?y=1' })).toBeUndefined();
    send.run(req, { url: 'http://attacker.test/z' });
    expect(s.seen.map((r) => r.url)).toEqual(['http://citadel.test/x?y=1']);
    expect(w.attackerLog.entries().map((e) => e.url)).toEqual(['http://attacker.test/z']);
    expect(sendLinkAction(() => b, { name: 'share', label: { id: 'Bagikan', en: 'Share' }, rearm: noRearm })).toMatchObject({ name: 'share', label: { en: 'Share' } });
  });

  it('the re-arm step runs at the start of EVERY action, before the victim browses (a link may have signed it out)', () => {
    const w = world();
    const s = site({ '/me': (r) => ({ status: 200, body: r.cookies.sid ?? 'signed out' }), '/logout': { status: 200, headers: { 'set-cookie': 'sid=; Max-Age=0' } } });
    const b = inSession(() => w.browser(s.handler));
    const calls: string[] = [];
    const rearm = (r: Request, browser: typeof b): void => {
      calls.push(`${r === req} ${browser === b} ${browser.cookies.get('sid') ?? 'none'}`);
      browser.cookies.set('sid', 'admin');
    };
    const send = sendLinkAction(() => b, { rearm });
    const check = checkMailAction({ browser: () => b, mailbox: ADMIN_MAILBOX, rearm });
    send.run(req, { url: 'http://citadel.test/logout' });
    expect(b.cookies.get('sid')).toBeUndefined(); // the player's link signed the victim out...
    expect(send.run(req, { url: 'http://citadel.test/me' })).toBeUndefined();
    expect(w.visits.at(-1)?.page?.body).toBe('admin'); // ...and the next action re-armed it first
    check.run(req, { url: '' }); // even an action that ends up doing nothing (no mail)
    expect(calls).toEqual(['true true none', 'true true none', 'true true admin']);
  });

  it('refuses bad options when the lab is defined, and a mailbox the world does not have when it runs', () => {
    const browser = () => { throw new Error('not called'); };
    expect(() => checkMailAction({ browser: 'x' as never, mailbox: ADMIN_MAILBOX, rearm: noRearm })).toThrow(/browser/);
    expect(() => checkMailAction({ browser, mailbox: 5 as never, rearm: noRearm })).toThrow(/mailbox/);
    for (const link of [-1, SIM_LIMITS.linksPerMail, 1.5, Number.NaN]) {
      expect(() => checkMailAction({ browser, mailbox: ADMIN_MAILBOX, link, rearm: noRearm }), String(link)).toThrow(/link/);
    }
    expect(() => checkMailAction({ browser, mailbox: ADMIN_MAILBOX, rearm: 'x' as never })).toThrow(/rearm/);
    expect(() => sendLinkAction('x' as never, { rearm: noRearm })).toThrow(/browser/);
    expect(() => sendLinkAction(browser, { rearm: 5 as never })).toThrow(/rearm/);
    const w = world([]);
    const b = inSession(() => w.browser(site({}).handler));
    expect(() => checkMailAction({ browser: () => b, mailbox: ADMIN_MAILBOX, rearm: noRearm }).run(req, { url: '' })).toThrow(/no mailbox/);
  });

  it('rearm is required: a victim with no standing state to restore passes an explicit no-op', () => {
    const browser = () => { throw new Error('not called'); };
    expect(() => checkMailAction({ browser, mailbox: ADMIN_MAILBOX } as never)).toThrow(/checkMailAction: rearm is required/);
    expect(() => sendLinkAction(browser, {} as never)).toThrow(/sendLinkAction: rearm is required/);
    expect(() => sendLinkAction(browser, undefined as never)).toThrow(/sendLinkAction: rearm is required/);
    expect(() => checkMailAction({ browser, mailbox: ADMIN_MAILBOX, rearm: () => {} })).not.toThrow();
  });
});

describe('memory: what the sim keeps is bounded by SIM_LIMITS', () => {
  it('a clipped field is a real copy: an attacker-sized parent string is not kept alive', () => {
    // V8's slice() of a long string may be a view that keeps the WHOLE parent alive; measured with a full GC
    // (exposed at runtime), the margin is about 50x either way, so this is not timing- or GC-noise-sensitive.
    const gc = fullGc();
    const big = (tag: string) => `${tag}`.padEnd(100_000, 'x');
    const logs = Array.from({ length: 4 }, () => inSession(() => attackerLog()));
    // Cookies parsed from Set-Cookie lines with a long (ignored) attribute: a stored value must not pin its line.
    const browsers = Array.from({ length: 4 }, (_, j) => inSession(() => world().browser(site({
      '/set': () => ({ status: 200, headers: { 'set-cookie': Array.from({ length: SIM_LIMITS.cookies }, (_, i) => `c${i}=${`v${j}-${i}`.padEnd(40, 'v')}; Expires=${big(`e${j}-${i}`)}`) } }),
    }).handler)));
    gc(); gc();
    const before = process.memoryUsage().heapUsed;
    logs.forEach((log, l) => {
      for (let i = 0; i < SIM_LIMITS.logEntries; i++) {
        log.record({ method: 'GET', url: big(`u${l}-${i}`), referer: big(`r${l}-${i}`), body: big(`b${l}-${i}`) });
      }
    });
    for (const b of browsers) b.follow('http://citadel.test/set');
    gc(); gc();
    const retained = process.memoryUsage().heapUsed - before;
    // As slices: 4 logs x 30 entries x 3 fields x 100 KB = 36 MB, plus 4 jars x 20 lines x 100 KB = 8 MB. As copies: < 1 MB.
    expect(retained).toBeLessThan(4 * 1024 * 1024);
    expect(browsers.every((b) => b.cookies.size === SIM_LIMITS.cookies)).toBe(true);
  });

  it('a mail keeps the mailbox\'s own address as `to`: a padded address (from a form) is not kept alive', () => {
    const gc = fullGc();
    const worlds = Array.from({ length: 4 }, () => world());
    gc(); gc();
    const before = process.memoryUsage().heapUsed;
    worlds.forEach((w, i) => {
      for (let m = 0; m < SIM_LIMITS.mailsPerMailbox; m++) {
        const mail = w.inbox.deliver({ from: 'x@citadel.test', to: `${' '.repeat(200_000 + i * 10 + m)}${ADMIN_MAILBOX}`, subject: 's', body: 'b' });
        expect(mail?.to).toBe(ADMIN_MAILBOX);
      }
    });
    gc(); gc();
    // As trim()/toLowerCase() views: 4 x 10 x 200 KB = 8 MB. As the mailbox's own address: nothing new.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(1024 * 1024);
    expect(worlds[0].inbox.addresses).toEqual([PLAYER_MAILBOX, ADMIN_MAILBOX]);
  });

  it('a URL the sim keeps (classifySimUrl fields, hops, pages) is its own text: a long fragment does not pin the href', () => {
    const gc = fullGc();
    // Each URL is short, but its href carries a fragment that percent-encodes to ~16 KB (1800 x 9 chars).
    const long = (i: number) => `http://citadel.test/p${i}/a-long-path-segment?q=${i}-a-long-query-value#${'✓'.repeat(1800)}`;
    const worlds = Array.from({ length: 40 }, () => { const w = world(); return { w, b: inSession(() => w.browser(() => ({ status: 200 }))) }; });
    gc(); gc();
    const before = process.memoryUsage().heapUsed;
    const fields = Array.from({ length: 300 }, (_, i) => { const u = classifySimUrl(long(i)); return [u.url, u.origin, u.host, u.path, u.search]; });
    worlds.forEach(({ b }, j) => { for (let v = 0; v < SIM_LIMITS.visits; v++) b.follow(long(j * 10 + v)); });
    gc(); gc();
    // Pinned hrefs: 300 + 40 x 5 URLs x ~16 KB = ~8 MB. As copies of their own text: well under 1 MB.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(1024 * 1024);
    expect(fields[0]).toEqual(['http://citadel.test/p0/a-long-path-segment?q=0-a-long-query-value', 'http://citadel.test', 'citadel.test', '/p0/a-long-path-segment', '?q=0-a-long-query-value']);
    expect(worlds[0].w.visits[0].page?.url).toBe('http://citadel.test/p0/a-long-path-segment?q=0-a-long-query-value');
  });

  it('each sim store, filled to every cap with two-byte text, retains less than its declared weight', () => {
    const gc = fullGc();
    const two = (n: number, tag: string) => `${tag}`.padEnd(n, '✓');
    const long = (n: number, tag: string) => `http://citadel.test/${tag}/`.padEnd(n, 'a');
    const measure = <T>(make: () => T, fill: (x: T, i: number) => void): number => {
      const xs = Array.from({ length: 8 }, () => inSession(make));
      gc(); gc();
      const a = process.memoryUsage();
      xs.forEach(fill);
      gc(); gc();
      const b = process.memoryUsage();
      return ((b.heapUsed - a.heapUsed) + (b.arrayBuffers - a.arrayBuffers)) / xs.length;
    };
    const inbox = measure(() => simInbox({ mailboxes: [ADMIN_MAILBOX, 'third@citadel.test'] }), (box, i) => {
      for (const to of box.addresses) {
        for (let m = 0; m < SIM_LIMITS.mailsPerMailbox; m++) {
          box.deliver({ from: two(SIM_LIMITS.addressLength, `f${i}${m}`), to, subject: two(SIM_LIMITS.subjectLength, `s${i}${m}`),
            body: two(SIM_LIMITS.bodyLength, `b${i}${m}`), links: [0, 1, 2].map((k) => two(SIM_LIMITS.urlLength + 1, `l${i}${m}${k}`)) });
        }
      }
    });
    const log = measure(() => attackerLog(), (l, i) => {
      for (let e = 0; e < SIM_LIMITS.logEntries; e++) {
        l.record({ method: 'PROPFINDXX', url: two(SIM_LIMITS.urlLength, `u${i}${e}`), referer: two(SIM_LIMITS.urlLength, `r${i}${e}`), body: two(SIM_LIMITS.urlLength, `b${i}${e}`) });
      }
    });
    // Visits: each follows 10 redirects with long URLs and a long Referer on every hop, then ends on a page.
    const visits = measure(() => {
      const w = simWorld();
      return w.browser((r) => {
        const n = Number(r.query.get('n') ?? '0');
        if (n < SIM_LIMITS.maxRedirects) return { status: 302, headers: { location: `${long(SIM_LIMITS.urlLength - 10, `p${n}`)}?n=${n + 1}` } };
        return { status: 200, body: two(SIM_LIMITS.bodyLength, 'page') };
      });
    }, (b, i) => {
      for (let v = 0; v < SIM_LIMITS.visits; v++) b.follow(`${long(SIM_LIMITS.urlLength - 10, `s${i}${v}`)}?n=0`, { referrer: long(SIM_LIMITS.urlLength, `r${i}${v}`) });
    });
    const jar = measure(() => simWorld().browser(() => ({ status: 200 })), (b, i) => {
      for (let c = 0; c < SIM_LIMITS.cookies; c++) b.cookies.set(`c${i}_${c}`, two(SIM_LIMITS.cookieBytes - 12, `v${i}${c}`), { path: `/${'p'.repeat(1023)}` });
    });
    // Measured on this box: ~515, ~366, ~252 and ~183 KiB; the weights add ~10%, rounded up to 32 KiB.
    expect(inbox).toBeLessThan(SIM_LIMITS.inboxWeight);
    expect(log).toBeLessThan(SIM_LIMITS.attackerLogWeight);
    expect(visits).toBeLessThan(SIM_LIMITS.visitsWeight);
    expect(jar).toBeLessThan(SIM_LIMITS.browserWeight);
    expect(Math.min(inbox, log, visits, jar)).toBeGreaterThan(100 * 1024); // the fill really filled them
  });

  it('clipping keeps every UTF-16 code unit exactly, lone surrogates included', () => {
    const log = inSession(() => attackerLog());
    const odd = `a\uD800b\uDFFFc􏰀é✓${'\uD800'.repeat(SIM_LIMITS.urlLength)}`;
    expect(log.record({ method: 'GET', url: odd.slice(0, 20) }).url).toBe(odd.slice(0, 20));
    expect(log.record({ method: 'GET', url: odd }).url).toBe(odd.slice(0, SIM_LIMITS.urlLength));
    expect(log.record({ method: 'GET', url: '' }).url).toBe('');
  });

  it('a cookie Path attribute over 1024 chars is ignored (RFC 6265bis): the default path applies', () => {
    const w = world();
    const s = site({ '/x/login': { status: 200, headers: { 'set-cookie': `a=1; Path=/${'p'.repeat(1024)}` } } });
    const b = inSession(() => w.browser(s.handler));
    b.follow('http://citadel.test/x/login');
    expect(b.cookies.list().map((c) => c.path)).toEqual(['/x']);
    expect(() => b.cookies.set('b', '1', { path: `/${'p'.repeat(1024)}` })).toThrow(/path/);
    b.cookies.set('c', '1', { path: `/${'p'.repeat(1023)}` });
    expect(b.cookies.size).toBe(2);
  });
});

describe('no real network', () => {
  it('the guard flags every way to reach a module or a global it does not allow (self-test)', () => {
    const evasions = [
      "import 'node:http';", "import * as h from 'node:https';", 'const m = await import(`node:http`);', "export * from 'node:tls';",
      "export { connect } from 'node:net';", "import d = require('node:dns');", "const r = require('node:dgram');",
      "globalThis['fe' + 'tch']('http://x');", "fetch('http://x');", "new WebSocket('ws://x');", 'process.binding("tcp_wrap");',
      "(0, eval)('1');", "Function('return this')();", "import { request } from 'undici';", "import x from './render.js'; import y from 'express';",
    ];
    for (const src of evasions) {
      const { runtime, problems } = simSourceCheck(src);
      expect([...runtime.filter((m) => !SIM_ALLOWED_IMPORTS.has(m)), ...problems], src).not.toEqual([]);
    }
    expect(simSourceCheck("import type { Request } from 'express'; import { t } from './i18n.js';")).toEqual({ runtime: ['./i18n.js'], problems: [] });
  });

  it('src/core/sim/ imports only what the allow-list names, never loads code dynamically, and names no network global', () => {
    expect(SIM_FILES).toEqual(['browser.ts', 'cookies.ts', 'limits.ts', 'url.ts', 'world.ts']);
    for (const file of SIM_FILES) {
      const { runtime, problems } = simSourceCheck(readFileSync(new URL(file, SIM_DIR), 'utf8'));
      expect(runtime.filter((m) => !SIM_ALLOWED_IMPORTS.has(m)), file).toEqual([]);
      expect(problems, file).toEqual([]);
    }
  });

  it('everything src/core/sim/ loads at runtime, transitively, reaches only node:buffer (no fs, no Express, no network)', () => {
    const seen = new Set<string>();
    const outside = new Set<string>();
    const walk = (file: URL): void => {
      if (seen.has(file.href)) return;
      seen.add(file.href);
      for (const m of simSourceCheck(readFileSync(file, 'utf8')).runtime) {
        if (m.startsWith('.')) walk(new URL(m.replace(/\.js$/, '.ts'), file));
        else outside.add(m);
      }
    };
    for (const file of SIM_FILES) walk(new URL(file, SIM_DIR));
    expect([...outside].sort()).toEqual(['node:buffer']);
    const core = new URL('../src/core/', import.meta.url).href;
    expect([...seen].map((h) => h.slice(core.length)).sort()).toEqual(['lab.ts', 'levels.ts', ...SIM_FILES.map((f) => `sim/${f}`)]);
  });

  /**
   * Trap every network function: each becomes a spy that THROWS `guard: <name>` and never calls the real function, so
   * a regression fails the test instead of opening a connection. The spies sit on the CommonJS export objects;
   * syncBuiltinESMExports() points the builtins' ES-module bindings at them too, so `import { request } from
   * 'node:http'` callers are trapped as well (the self-test checks the binding before any call).
   */
  const installNetSpies = () => {
    const require = createRequire(import.meta.url);
    const trap = (mod: object, name: string) =>
      vi.spyOn(mod as Record<string, () => unknown>, name).mockImplementation(() => { throw new Error(`guard: ${name}`); });
    const on = (id: string, fns: readonly string[]) => fns.map((f) => trap(require(id) as object, f));
    const dns = require('node:dns') as { promises: object };
    const spies = [
      trap(globalThis, 'fetch'),
      ...on('node:http', ['request', 'get']), ...on('node:https', ['request', 'get']), ...on('node:http2', ['connect']),
      ...on('node:tls', ['connect']), ...on('node:net', ['connect', 'createConnection']), ...on('node:dgram', ['createSocket']),
      ...on('node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']),
      ...(['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny'] as const).map((f) => trap(dns.promises, f)),
    ];
    syncBuiltinESMExports();
    return spies;
  };
  const releaseSpies = (spies: ReturnType<typeof installNetSpies>): void => {
    for (const spy of spies) spy.mockRestore();
    syncBuiltinESMExports();
  };

  it('the network spies throw instead of passing through, and reach ES-module imports (self-test, nothing real is called)', () => {
    const spies = installNetSpies();
    try {
      // Every spy has a throwing implementation: a call can never reach the real function.
      for (const spy of spies) expect(spy.getMockImplementation(), spy.getMockName()).toBeDefined();
      // The ESM binding IS the spy, checked before any call (without syncBuiltinESMExports it is the real function).
      expect(vi.isMockFunction(createConnection)).toBe(true);
      expect(() => createConnection({ port: 9 })).toThrow('guard: createConnection');
    } finally {
      releaseSpies(spies);
    }
    expect(vi.isMockFunction(createConnection)).toBe(false);
  });

  it('a full visit (citadel redirect -> attacker, an unreachable host) touches no network function', () => {
    const spies = installNetSpies();
    try {
      const w = world();
      const s = site({ '/a': { status: 200, headers: { refresh: '0;url=http://attacker.test/x' } } });
      const v = inSession(() => w.browser(s.handler)).follow('http://citadel.test/a?code=1');
      expect(v.outcome).toBe('attacker');
      inSession(() => w.browser(s.handler)).follow('http://example.com/');
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      releaseSpies(spies);
    }
  });
});

