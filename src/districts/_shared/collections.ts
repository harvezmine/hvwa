// src/districts/_shared/collections.ts — bounded maps and random ids for a lab's per-session state, any district.
// Platform safety, not the lesson: a map keyed by what a player can make up (session ids, codes, tokens, states) must
// stay bounded (docs/RECIPES.md section 4, "Bound every map keyed by attacker input"). Which entries a lab pins, and
// what it stores, is the lab's decision; a level's flaw never lives here.
import { randomBytes } from 'node:crypto';

/** A fresh random id: 16 CSPRNG bytes as 32 hex characters (sessions, codes, states, a lab's admin password). */
export const newId = (): string => randomBytes(16).toString('hex');

/** How trimBounded trims a map (oldest first: a Map iterates in insertion order). */
export interface Bound<V> {
  /** Most entries kept. */
  readonly max: number;
  /**
   * Never evicted, e.g. the admin's own session, which the lab depends on: a trim skips it. With every remaining
   * entry pinned the trim stops, so the map may stay above `max` (pin only what the lab itself created).
   */
  readonly pin?: (key: string, value: V) => boolean;
  /** Evicted only when nothing else can go, oldest first among them, e.g. signed-in sessions after anonymous ones. */
  readonly spare?: (key: string, value: V) => boolean;
}

function checkMax(max: number): void {
  if (!Number.isInteger(max) || max < 0) throw new Error(`bounded map: max must be a non-negative integer (got ${String(max)})`);
}

/**
 * Evict entries until `m` holds at most `max`: the oldest entry that is neither pinned nor spared goes first; when only
 * spared (and pinned) entries are left, the oldest spared one. Pinned entries never go.
 */
export function trimBounded<V>(m: Map<string, V>, bound: Bound<V>): void {
  const { max, pin, spare } = bound;
  checkMax(max);
  while (m.size > max) {
    let victim: string | undefined;
    let spared: string | undefined;
    for (const [k, v] of m) {
      if (pin?.(k, v) === true) continue;
      if (spare?.(k, v) === true) { spared ??= k; continue; }
      victim = k;
      break;
    }
    const k = victim ?? spared;
    if (k === undefined) return; // everything left is pinned
    m.delete(k);
  }
}

/** Store under `key`, newest last; beyond `max` entries the oldest key that `keep` does not pin goes. */
export function putBounded<V>(m: Map<string, V>, key: string, value: V, max: number, keep: (k: string) => boolean = () => false): void {
  checkMax(max);
  m.delete(key);
  m.set(key, value);
  trimBounded(m, { max, pin: (k) => keep(k) });
}
