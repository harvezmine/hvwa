import type { Plan, PlanInput } from '../model.js';

// INQUISITOR — a real page cap: the page size is clamped to 1-100, and 0 or a negative is no way round it. The flaw:
// the work per row is not bounded. `expand` follows relations to any depth (the route only stops a path at its own
// parser bound), and there is no cost budget, so each `.related` multiplies the work of the same 100 rows by 20.
export function plan(i: PlanInput): Plan {
  return {
    rows: Math.min(Math.max(parseInt(i.limit ?? '', 10) || 100, 1), 100),
    expand: i.expand === undefined || i.expand === '' ? [] : i.expand.split('.'),
  };
}

export function overBudget(_cost: number): string | undefined {
  return undefined;
}
