import type { ChallengeDb } from '../../../../core/challenge-db.js';
import { firstRows } from '../../_shared/sql.js';
import { MAX_ROWS, type Row } from '../model.js';

// DIVINE — secure reference: both fields are bound parameters, and the max price must be a whole number of dollars
// (an anchored allowlist on the value that is USED, not just a check that it starts like one). The query has a LIMIT as
// well as the reader's cap, and the route (tryDb) shows Divine players only a generic "Invalid request." for a
// database error, never its message (CWE-209).
// ASVS 5.0 V1.2 (parameterized queries) and V2.2 (validate the value you use).
// Out of scope here: LIKE wildcards in the search term only widen a search of rows the user may see anyway.
export function search(db: ChallengeDb, q: string, max: string): Row[] | string {
  if (!/^\d{1,7}$/.test(max)) return 'Max price must be a whole number of dollars.';
  return firstRows(db.prepare(
    `SELECT name, category, price_cents, description FROM products WHERE hidden = 0 AND name LIKE ? AND price_cents / 100 <= ? ORDER BY name LIMIT ${MAX_ROWS}`,
  ), MAX_ROWS, `%${q}%`, Number(max));
}
