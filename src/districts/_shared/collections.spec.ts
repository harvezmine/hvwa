// src/districts/_shared/collections.spec.ts — bounded maps and random ids for lab state.
import { describe, it, expect } from 'vitest';
import { newId, putBounded, trimBounded } from './collections.js';

const mapOf = <V>(...entries: [string, V][]) => new Map<string, V>(entries);

describe('newId', () => {
  it('is 16 CSPRNG bytes as 32 hex characters, never repeated', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('putBounded', () => {
  it('stores newest last; storing a key again makes it the newest', () => {
    const m = mapOf<number>(['a', 1], ['b', 2]);
    putBounded(m, 'c', 3, 10);
    putBounded(m, 'a', 4, 10);
    expect([...m]).toEqual([['b', 2], ['c', 3], ['a', 4]]);
  });

  it('beyond max the oldest goes', () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 5; i++) putBounded(m, `k${i}`, i, 3);
    expect([...m.keys()]).toEqual(['k2', 'k3', 'k4']);
  });

  it('a key `keep` pins is never pushed out (the admin\'s session), however many entries follow', () => {
    const m = mapOf<string>(['admin', 'citadel_admin']);
    for (let i = 0; i < 100; i++) putBounded(m, `s${i}`, 'pilgrim', 50, (k) => k === 'admin');
    expect(m.size).toBe(50);
    expect(m.get('admin')).toBe('citadel_admin');
    expect([...m.keys()].at(-1)).toBe('s99');
  });

  it('with every key pinned nothing is evicted (the map may exceed max)', () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 4; i++) putBounded(m, `k${i}`, i, 2, () => true);
    expect(m.size).toBe(4);
  });
});

describe('trimBounded', () => {
  it('trims the oldest entries down to max', () => {
    const m = mapOf<number>(['a', 1], ['b', 2], ['c', 3], ['d', 4]);
    trimBounded(m, { max: 2 });
    expect([...m.keys()]).toEqual(['c', 'd']);
    trimBounded(m, { max: 2 });
    expect([...m.keys()]).toEqual(['c', 'd']);
  });

  it('`pin` entries are never evicted', () => {
    const m = mapOf<number>(['admin', 0], ['a', 1], ['b', 2], ['c', 3]);
    trimBounded(m, { max: 2, pin: (k) => k === 'admin' });
    expect([...m.keys()]).toEqual(['admin', 'c']);
  });

  it('`spare` entries go only when nothing else is left: oldest unspared first, then the oldest spared', () => {
    type S = { user: string | null };
    const m = mapOf<S>(['s1', { user: 'pilgrim' }], ['a1', { user: null }], ['s2', { user: 'citadel_admin' }], ['a2', { user: null }]);
    const signedIn = (_k: string, s: S) => s.user !== null;
    trimBounded(m, { max: 3, spare: signedIn });
    expect([...m.keys()]).toEqual(['s1', 's2', 'a2']); // the oldest anonymous one went, not the older signed-in s1
    trimBounded(m, { max: 1, spare: signedIn });
    expect([...m.keys()]).toEqual(['s2']); // a2 (anonymous), then s1 (the oldest signed-in)
  });

  it('pins win over spares; with everything pinned nothing goes', () => {
    const m = mapOf<number>(['p', 0], ['s', 1], ['x', 2]);
    trimBounded(m, { max: 1, pin: (k) => k === 'p', spare: (k) => k === 's' });
    expect([...m.keys()]).toEqual(['p']);
    trimBounded(m, { max: 0, pin: () => true });
    expect([...m.keys()]).toEqual(['p']);
  });

  it('max must be a non-negative integer', () => {
    for (const max of [-1, 1.5, Number.NaN, Infinity]) {
      expect(() => trimBounded(new Map(), { max }), String(max)).toThrow(/max must be a non-negative integer/);
      expect(() => putBounded(new Map(), 'k', 1, max), String(max)).toThrow(/max must be a non-negative integer/);
    }
  });
});
