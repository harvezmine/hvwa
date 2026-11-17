import { TOTAL_ROWS, type Plan, type PlanInput, type Refusal } from '../model.js';

// DIVINE — secure reference: the page size is digits only and 1-100 (a missing limit is the default page of 100),
// `expand` allows at most one level and only `product`, and every request is held to a cost budget of 10 000 (413)
// whatever the arithmetic says. The export is paged by cursor.
// ASVS 5.0 V4 (API resource limits).
// Out of scope here: V2.4 anti-automation. A production API would also rate limit and authenticate callers; this lab
// has no limiter and keeps no per-caller state.

/** The most the work of one request may cost (rows x the fan-outs of the expansion). */
const COST_BUDGET = 10_000;

export function plan(i: PlanInput): Plan | Refusal {
  const limit = i.limit ?? '100';
  if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) {
    return { status: 400, error: 'limit must be between 1 and 100.' };
  }
  const expand = i.expand === undefined || i.expand === '' ? [] : i.expand.split('.');
  if (expand.length > 1) return { status: 400, error: 'expand: at most one level.' };
  if (expand.length === 1 && expand[0] !== 'product') return { status: 400, error: 'expand: only "product" may be expanded.' };
  return { rows: Math.min(Number(limit), TOTAL_ROWS - i.offset), expand };
}

export function overBudget(cost: number): string | undefined {
  return cost > COST_BUDGET ? `Cost budget exceeded: this request would build ${cost} rows, the budget is ${COST_BUDGET}.` : undefined;
}
