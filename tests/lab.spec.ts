// Engine helpers every challenge route uses (src/core/lab.ts).
import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { perLevel, byLevel, tryDb, field, DIVINE_DB_ERROR } from '../src/core/lab.js';
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
