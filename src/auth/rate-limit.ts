// src/auth/rate-limit.ts — a sliding-window counter per key (registrations and failed sign-ins per client IP, spec
// range §4 and §12). Bounded: at most `maxKeys` keys are tracked; the least recently used one is dropped first.
export interface WindowLimiter {
  /** Record one hit for `key` and return true, or return false (recording nothing) when the window is full. */
  allow(key: string): boolean;
  /** Hits of `key` inside the window now. */
  count(key: string): number;
}

export function windowLimiter(opts: { max: number; windowMs: number; now?: () => number; maxKeys?: number }): WindowLimiter {
  const { max, windowMs } = opts;
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 10_000;
  if (!Number.isInteger(max) || max < 1) throw new Error('windowLimiter: max must be a positive integer');
  if (!(windowMs > 0)) throw new Error('windowLimiter: windowMs must be positive');
  const hits = new Map<string, number[]>();
  const live = (key: string, t: number): number[] => {
    const list = (hits.get(key) ?? []).filter((at) => t - at < windowMs);
    hits.delete(key);
    if (list.length > 0) hits.set(key, list); // re-inserted: the most recently used key is last
    return list;
  };
  return {
    allow(key: string): boolean {
      const t = now();
      const list = live(key, t);
      if (list.length >= max) return false;
      list.push(t);
      hits.delete(key);
      hits.set(key, list);
      while (hits.size > maxKeys) {
        const oldest = hits.keys().next().value;
        if (oldest === undefined) break;
        hits.delete(oldest);
      }
      return true;
    },
    count: (key: string) => live(key, now()).length,
  };
}
