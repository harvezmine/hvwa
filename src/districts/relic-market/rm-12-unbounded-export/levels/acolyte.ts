import { TOTAL_ROWS, type Plan, type PlanInput } from '../model.js';

// ACOLYTE — no defense. The page size is whatever `limit` says: there is no cap, so one request can ask for the whole
// ledger (the route still never builds more than a 20-row preview: the cost is only computed).
export function plan(i: PlanInput): Plan {
  return {
    rows: Math.min(parseInt(i.limit ?? '', 10) || 100, TOTAL_ROWS - i.offset),
    expand: i.expand === undefined || i.expand === '' ? [] : i.expand.split('.'),
  };
}

export function overBudget(_cost: number): string | undefined {
  return undefined;
}
