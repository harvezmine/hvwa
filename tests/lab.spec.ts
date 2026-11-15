// Engine helpers every challenge route uses (src/core/lab.ts).
import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { perLevel, perSession, byLevel, tryDb, field, header, fixtureLines, sendLines, DIVINE_DB_ERROR } from '../src/core/lab.js';
import type { Level } from '../src/core/levels.js';

describe('perLevel(factory)', () => {
  it('creates nothing until a level is asked for, then one instance per level', () => {
    const factory = vi.fn((level: Level) => ({ level, secret: Math.random() }));
    const p = perLevel(factory);
    expect(factory).not.toHaveBeenCalled();
    const a = p.for('acolyte');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenLastCalledWith('acolyte');
    expect(a.level).toBe('acolyte');
    const t = p.for('templar');
    const i = p.for('inquisitor');
    const d = p.for('divine');
    expect(new Set([a, t, i, d]).size).toBe(4);
    expect(new Set([a.secret, t.secret, i.secret, d.secret]).size).toBe(4);
  });

  it('caches per level: the same level always returns the same instance', () => {
    const factory = vi.fn(() => ({}));
    const p = perLevel(factory);
    const first = p.for('templar');
    expect(p.for('templar')).toBe(first);
    expect(p.for('templar')).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('two perLevel() holders never share instances', () => {
    const p1 = perLevel(() => ({}));
    const p2 = perLevel(() => ({}));
    expect(p1.for('acolyte')).not.toBe(p2.for('acolyte'));
  });

  it('rejects a value that is not a level (no instance for "toString" etc.)', () => {
    const factory = vi.fn(() => ({}));
    const p = perLevel(factory);
    for (const bad of ['god', 'toString', '__proto__', '']) {
      expect(() => p.for(bad as Level), bad).toThrow(/not a level/);
    }
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('perSession(factory, opts?)', () => {
  const S1 = '11111111-1111-4111-8111-111111111111';
  const S2 = '22222222-2222-4222-8222-222222222222';
  const S3 = '33333333-3333-4333-8333-333333333333';
  const req = (sessionId: string, level: Level = 'acolyte') => ({ sessionId, level });

  it('creates lazily with factory(level, sessionId) and caches per (session, level)', () => {
    const factory = vi.fn((level: Level, sid: string) => ({ level, sid }));
    const p = perSession(factory);
    expect(factory).not.toHaveBeenCalled();
    const a = p.for(req(S1, 'templar'));
    expect(a).toEqual({ level: 'templar', sid: S1 });
    expect(factory).toHaveBeenLastCalledWith('templar', S1);
    expect(p.for(req(S1, 'templar'))).toBe(a);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(p.size).toBe(1);
  });

  it('isolates sessions: one player never sees another player\'s instance', () => {
    const p = perSession(() => ({ balance: 100 }));
    p.for(req(S1)).balance = 0; // S1's exploit drains their own lab
    expect(p.for(req(S2)).balance).toBe(100);
    expect(p.for(req(S1)).balance).toBe(0);
  });

  it('isolates levels within one session (no perLevel needed on top)', () => {
    const p = perSession(() => ({ role: 'user' }));
    p.for(req(S1, 'acolyte')).role = 'admin';
    for (const level of ['templar', 'inquisitor', 'divine'] as const) {
      expect(p.for(req(S1, level)).role, level).toBe('user');
    }
    expect(p.size).toBe(4);
  });

  it('evicts the least recently used instance beyond maxEntries', () => {
    const factory = vi.fn((_l: Level, sid: string) => ({ sid }));
    const p = perSession(factory, { maxEntries: 2 });
    const a = p.for(req(S1));
    const b = p.for(req(S2));
    expect(p.for(req(S1))).toBe(a); // touch S1: S2 is now least recently used
    p.for(req(S3));
    expect(p.size).toBe(2);
    expect(p.for(req(S1))).toBe(a); // kept
    expect(factory).toHaveBeenCalledTimes(3);
    const b2 = p.for(req(S2)); // was evicted: a fresh instance
    expect(b2).not.toBe(b);
    expect(factory).toHaveBeenCalledTimes(4);
    expect(p.size).toBe(2);
  });

  it('drops an instance idle for longer than idleTtlMs (injectable clock); use refreshes it', () => {
    let t = 0;
    const factory = vi.fn(() => ({}));
    const p = perSession(factory, { idleTtlMs: 1000, now: () => t });
    const a = p.for(req(S1));
    p.for(req(S2));
    t = 1000;
    expect(p.for(req(S1))).toBe(a); // exactly the TTL idle: still alive, and refreshed
    t = 1900;
    expect(p.for(req(S1))).toBe(a); // 900 ms since last use
    expect(p.size).toBe(1);         // S2 (idle 1900 ms) was swept
    t = 2901;
    expect(p.for(req(S1))).not.toBe(a); // idle 1001 ms: expired, fresh instance
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it('dispose(value) runs on LRU eviction and on TTL expiry, never on a plain hit; its errors are ignored', () => {
    let t = 0;
    const disposed: string[] = [];
    const p = perSession((_l, sid) => ({ sid }), {
      maxEntries: 2, idleTtlMs: 1000, now: () => t,
      dispose: (v) => { disposed.push(v.sid); throw new Error('dispose blew up'); },
    });
    p.for(req(S1));
    p.for(req(S1)); // hit: nothing disposed
    expect(disposed).toEqual([]);
    p.for(req(S2));
    p.for(req(S3)); // beyond maxEntries: S1 (least recently used) is evicted
    expect(disposed).toEqual([S1]);
    expect(p.size).toBe(2);
    t = 5000;
    p.for(req(S1)); // both S2 and S3 idled past the TTL: swept, then S1 is rebuilt
    expect(disposed).toEqual([S1, S2, S3]);
    expect(p.size).toBe(1);
  });

  it('reset(req) drops that (session, level) only, disposes it, and the next for() builds a fresh one', () => {
    const disposed: string[] = [];
    const p = perSession((l, sid) => ({ l, sid, n: Math.random() }), { dispose: (v) => { disposed.push(`${v.l}|${v.sid}`); } });
    const a1 = p.for(req(S1, 'acolyte'));
    const t1 = p.for(req(S1, 'templar'));
    const b1 = p.for(req(S2, 'acolyte'));
    p.reset(req(S1, 'acolyte'));
    expect(disposed).toEqual([`acolyte|${S1}`]);
    expect(p.size).toBe(2);
    expect(p.for(req(S1, 'acolyte'))).not.toBe(a1);
    expect(p.for(req(S1, 'templar'))).toBe(t1);
    expect(p.for(req(S2, 'acolyte'))).toBe(b1);
    p.reset(req('44444444-4444-4444-8444-444444444444')); // nothing held: a no-op
    expect(() => p.reset({ sessionId: '', level: 'acolyte' })).toThrow(/sessionId/);
  });

  it('defaults: 5000 entries, 2 h idle TTL', () => {
    let t = 0;
    const p = perSession((_l, sid) => sid, { now: () => t });
    for (let i = 0; i < 5001; i++) p.for(req(`sid-${i}`));
    expect(p.size).toBe(5000);
    const first = p.for(req('sid-5000'));
    t = 2 * 60 * 60 * 1000;
    expect(p.for(req('sid-5000'))).toBe(first);
    t += 2 * 60 * 60 * 1000 + 1;
    p.for(req('late'));
    expect(p.size).toBe(1);
  });

  it('rejects bad options and bad requests', () => {
    for (const maxEntries of [0, -1, 1.5, Number.NaN]) {
      expect(() => perSession(() => ({}), { maxEntries }), String(maxEntries)).toThrow(/maxEntries/);
    }
    for (const idleTtlMs of [0, -5, Number.NaN]) {
      expect(() => perSession(() => ({}), { idleTtlMs }), String(idleTtlMs)).toThrow(/idleTtlMs/);
    }
    const p = perSession(() => ({}));
    expect(() => p.for({ sessionId: S1, level: 'god' as Level })).toThrow(/not a level/);
    expect(() => p.for({ sessionId: '', level: 'acolyte' })).toThrow(/sessionId/);
    expect(() => p.for({ sessionId: undefined as unknown as string, level: 'acolyte' })).toThrow(/sessionId/);
  });
});

interface Mod { run(): string }
const mod = (name: string): Mod => ({ run: () => name });

describe('byLevel(modules)', () => {
  it('lists the provided levels in rank order, whatever the key order', () => {
    const impl = byLevel<Mod>({ divine: mod('d'), inquisitor: mod('i'), acolyte: mod('a'), templar: mod('t') });
    expect(impl.levels).toEqual(['acolyte', 'templar', 'inquisitor', 'divine']);
    expect(Object.isFrozen(impl.levels)).toBe(true);
    expect(impl.for('acolyte').run()).toBe('a');
    expect(impl.for('templar').run()).toBe('t');
    expect(impl.for('inquisitor').run()).toBe('i');
    expect(impl.for('divine').run()).toBe('d');
  });

  it('a 3-level challenge lists only its levels and refuses the missing one', () => {
    const impl = byLevel<Mod>({ acolyte: mod('a'), inquisitor: mod('i'), divine: mod('d') });
    expect(impl.levels).toEqual(['acolyte', 'inquisitor', 'divine']);
    expect(impl.for('inquisitor').run()).toBe('i');
    expect(() => impl.for('templar')).toThrow(/templar.*not implemented/);
  });

  it('treats an undefined entry as not provided', () => {
    const impl = byLevel<Mod>({ acolyte: mod('a'), templar: undefined, divine: mod('d') });
    expect(impl.levels).toEqual(['acolyte', 'divine']);
  });

  it('rejects unknown keys and an empty map', () => {
    expect(() => byLevel<Mod>({ acolyt: mod('x') } as never)).toThrow(/unknown level "acolyt"/);
    expect(() => byLevel<Mod>({})).toThrow(/at least one level/);
  });

  it('refuses inherited names as levels', () => {
    const impl = byLevel<Mod>({ acolyte: mod('a') });
    expect(() => impl.for('toString' as Level)).toThrow(/not implemented/);
  });

  it('checks every module against one shared interface (type level)', () => {
    const impl = byLevel<Mod>({ acolyte: mod('a') });
    expectTypeOf(impl.for).returns.toEqualTypeOf<Mod>();
    expectTypeOf(impl.levels).toEqualTypeOf<readonly Level[]>();
    // Compile-time only (never called): `npm run typecheck` fails if these compile.
    const neverCalled = () => {
      // @ts-expect-error — a module missing run() does not satisfy Mod
      byLevel<Mod>({ acolyte: mod('a'), divine: { nope: 1 } });
      // @ts-expect-error — 'acolyt' is not a level
      byLevel<Mod>({ acolyt: mod('a') });
    };
    expect(typeof neverCalled).toBe('function');
    // Without an explicit module type nothing is inferred: for() returns unknown,
    // so a forgotten <M> cannot silently accept mismatched level modules.
    expectTypeOf(byLevel({ acolyte: mod('a') }).for).returns.toEqualTypeOf<unknown>();
  });
});

describe('tryDb(req, fn)', () => {
  const boom = () => { throw new Error('near "x": syntax error'); };

  it('returns the value when fn succeeds, at every level', () => {
    for (const level of ['acolyte', 'templar', 'inquisitor', 'divine'] as const) {
      expect(tryDb({ level }, () => 42)).toEqual({ ok: true, value: 42 });
    }
  });

  it.each(['acolyte', 'templar', 'inquisitor'] as const)(
    'below Divine (%s) the error message is shown: error-based learning (CWE-209 by design)', (level) => {
      expect(tryDb({ level }, boom)).toEqual({ ok: false, message: 'Database error: near "x": syntax error' });
    });

  it('at Divine the message is generic and leaks nothing from the error', () => {
    const r = tryDb({ level: 'divine' }, boom);
    expect(r).toEqual({ ok: false, message: DIVINE_DB_ERROR });
    expect(DIVINE_DB_ERROR).toBe('Invalid request.');
    expect(JSON.stringify(r)).not.toMatch(/syntax|near|Database error/i);
  });

  it('handles a non-Error throw', () => {
    expect(tryDb({ level: 'acolyte' }, () => { throw 'raw'; })).toEqual({ ok: false, message: 'Database error: raw' });
  });

  it('takes an optional label for non-DB labs (parsers); Divine stays generic', () => {
    const bad = () => { throw new Error('unexpected end of document'); };
    expect(tryDb({ level: 'templar' }, bad, 'Parser error'))
      .toEqual({ ok: false, message: 'Parser error: unexpected end of document' });
    expect(tryDb({ level: 'divine' }, bad, 'Parser error')).toEqual({ ok: false, message: DIVINE_DB_ERROR });
  });

  it('refuses an async fn at every level: a thenable is a programming error, not a DB error', () => {
    for (const level of ['acolyte', 'divine'] as const) {
      expect(() => tryDb({ level }, async () => 1), level).toThrow(/tryDb.*synchronous/);
      expect(() => tryDb({ level }, () => ({ then: () => {} })), level).toThrow(/tryDb.*synchronous/);
    }
  });

  it('a rejecting async fn throws the guard error and leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      expect(() => tryDb({ level: 'acolyte' }, async () => { throw new Error('late'); })).toThrow(/synchronous/);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('narrows on ok (type level)', () => {
    const r = tryDb({ level: 'acolyte' }, () => 'v');
    if (r.ok) expectTypeOf(r.value).toEqualTypeOf<string>();
    else expectTypeOf(r.message).toEqualTypeOf<string>();
  });
});

describe('field(req, name)', () => {
  it('returns a string body field', () => {
    expect(field({ body: { username: 'pilgrim' } }, 'username')).toBe('pilgrim');
    expect(field({ body: { username: '' } }, 'username')).toBe('');
  });

  it('returns "" for a missing field or a missing/non-object body', () => {
    expect(field({ body: {} }, 'username')).toBe('');
    expect(field({ body: undefined }, 'username')).toBe('');
    expect(field({ body: null }, 'username')).toBe('');
    expect(field({ body: 'username=x' }, 'username')).toBe('');
  });

  it('returns "" for non-string values (JSON objects, arrays, numbers, extended-urlencoded nesting)', () => {
    for (const v of [{ toString: 1 }, { toString: () => 'x' }, ['a', 'b'], 1, true, null]) {
      expect(field({ body: { username: v } }, 'username'), JSON.stringify(v)).toBe('');
    }
  });

  it('ignores inherited properties', () => {
    for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(field({ body: {} }, name), name).toBe('');
    }
  });
});

describe('fixtureLines(url) / sendLines(res, lines)', () => {
  const file = new URL('./fixtures/hello.ejs', import.meta.url);

  it('reads the file once, lazily, dropping blank lines (CRLF or LF)', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const dir = mkdtempSync(join(tmpdir(), 'hvwa-fx-'));
    try {
      const p = join(dir, 'list.txt');
      writeFileSync(p, 'one\r\n\r\ntwo\nthree\n\n');
      const lines = fixtureLines(pathToFileURL(p));
      expect(lines()).toEqual(['one', 'two', 'three']);
      writeFileSync(p, 'changed'); // read once: the cached list stays
      expect(lines()).toBe(lines());
      expect(Object.isFrozen(lines())).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect(() => fixtureLines(file)()).not.toThrow();
    expect(() => fixtureLines(new URL('./fixtures/nope.txt', import.meta.url))()).toThrow();
  });

  it('sends text/plain, one entry per line with a trailing newline', () => {
    const sent: string[] = [];
    const types: string[] = [];
    const res = { type(t: string) { types.push(t); return { send(b: string) { sent.push(b); } }; } };
    sendLines(res as never, ['a', 'b']);
    expect(types).toEqual(['text/plain']);
    expect(sent).toEqual(['a\nb\n']);
  });
});

describe('header(req, name)', () => {
  it('returns a header sent once as a string; undefined when missing or repeated; name is case-insensitive', () => {
    expect(header({ headers: { 'x-real-ip': '1.2.3.4' } }, 'X-Real-IP')).toBe('1.2.3.4');
    expect(header({ headers: {} }, 'x-real-ip')).toBeUndefined();
    expect(header({ headers: { 'x-real-ip': ['a', 'b'] } }, 'x-real-ip')).toBeUndefined();
  });
});
