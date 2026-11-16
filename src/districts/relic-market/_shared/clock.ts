// src/districts/relic-market/_shared/clock.ts — the Relic Market's injectable clock. Plumbing, not a lesson: race
// windows (race.ts) and simulated delays wait on it, so tests can make every wait instant or virtual.
// Not a challenge: nothing here is served by View Source.

/** What a lab waits on and reads the time from. */
export interface LabClock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Resolve after `ms` milliseconds (realClock clamps to 0 .. MAX_WAIT_MS). */
  wait(ms: number): Promise<void>;
}

/** The longest wait the shop ever makes: platform safety, so no request can be parked for longer. */
export const MAX_WAIT_MS = 5000;

const clampMs = (ms: number): number => (Number.isNaN(ms) ? 0 : Math.min(Math.max(ms, 0), MAX_WAIT_MS));

type ClockImpl = { readonly now: () => number; readonly wait: (ms: number) => Promise<void> };

const REAL: ClockImpl = {
  now: () => Date.now(),
  wait: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
};
let impl: ClockImpl = REAL;

/**
 * The clock every shop starts with (newShop): `now()` is Date.now and `wait(ms)` a real setTimeout, clamped to
 * 0 .. 5000 ms. It delegates to whatever setClockForTests installed, so module-level and per-session holders follow a
 * swap made after they were created.
 */
export const realClock: LabClock = Object.freeze({
  now: () => impl.now(),
  wait: (ms: number) => impl.wait(clampMs(ms)),
});

/**
 * Test seam: replace `now` and/or `wait` behind realClock (the clamp still applies before `wait`). Returns a function
 * that restores the previous clock. Module state is per spec file (Vitest isolates modules), so a swap never leaks into
 * another file; the test kit's useInstantWaits() and useFakeClock() install and restore it around a block.
 */
export function setClockForTests(o: { readonly now?: () => number; readonly wait?: (ms: number) => Promise<void> }): () => void {
  const prev = impl;
  impl = { now: o.now ?? prev.now, wait: o.wait ?? prev.wait };
  return () => { impl = prev; };
}
