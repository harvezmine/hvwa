import { TOTAL_ROWS, type Plan, type PlanInput } from '../model.js';

// TEMPLAR — a naive cap: a limit above 100 becomes 100. But an old branch of the code (from before pagination) treats a
// limit of zero or less as "no limit, give me everything", and the cap never looks at it.
export function plan(i: PlanInput): Plan {
  const asked = parseInt(i.limit ?? '', 10);
  const rows = asked <= 0 ? TOTAL_ROWS - i.offset : Math.min(asked > 0 ? asked : 100, 100);
  return { rows, expand: i.expand === undefined || i.expand === '' ? [] : i.expand.split('.') };
}

export function overBudget(_cost: number): string | undefined {
  return undefined;
}
