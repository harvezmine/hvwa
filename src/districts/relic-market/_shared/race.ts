// src/districts/relic-market/_shared/race.ts — the race primitives of the Relic Market labs (RM-07, RM-08). Plumbing,
// not a lesson: whether a level checks before or after its await, and what a lock is keyed on, lives in levels/*.ts.
// Not a challenge: nothing here is served by View Source.
//
// A racy level is `check -> await state.gate.pass(WINDOW_MS) -> update`, and its route calls `state.gate.arrive()` as
// its first statement, right before the level. Rule: a racy level function does no await before its check, so arrival,
// check and the await run in one synchronous segment. In production the window is a real timer, so requests that
// arrive within it really interleave on the event loop; tests install barrierGate(n) (shop-lab.testkit.ts) instead.
import type { LabClock } from './clock.js';

/** The pause between a racy level's check and its update. */
export interface Gate {
  /** Called by the route as its first statement: one request arrived. */
  arrive(): void;
  /** The level's window: resolves after `ms` (production) or once every expected request arrived (tests). */
  pass(ms: number): Promise<void>;
}

/** The production gate: arrive() does nothing and pass(ms) is the clock's wait, so the race window is real. */
export function waitGate(clock: LabClock): Gate {
  return Object.freeze({ arrive: () => {}, pass: (ms: number) => clock.wait(ms) });
}

/**
 * Promise chains per key: `run(key, fn)` starts `fn` once every earlier `run` with the same key has settled (FIFO),
 * while other keys run concurrently. A rejection reaches its own caller only and never blocks the queue. Idle keys
 * are deleted, and callers pass constant keys only (never attacker input), so the map stays as small as the lab's
 * own list of keys.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn);
    const tail = result.then(() => {}, () => {});
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return result;
  }

  /** Keys with a running or queued task. */
  get size(): number { return this.tails.size; }
}
