import type { ChallengeDb } from '../../../../core/challenge-db.js';

// DIVINE — secure reference: an anchored allowlist (no m flag: in JavaScript a bare $ matches only at the very end of
// the input, so a trailing or embedded newline is no match) and a bound parameter. The answer never depends on what
// the lookup finds, so there is no data-dependent work to time.
// ASVS 5.0 V1.2 (parameterized queries) and V2.2 (anchored allowlists for the value you use).
//
// Errors: a BLIND lab hides database errors at EVERY level, not only here (decision Q4). The route turns any database
// error into the same uniform answer as a hit or a miss, because an echoed SQLite message would make the lab no longer
// blind. That is deliberate, so the generic-error rule changes nothing at this level.
// Out of scope here: a production tracker would also rate-limit lookups and authenticate the customer.
export function lookup(db: ChallengeDb, orderNo: string): void | string {
  if (!/^RM-\d{4}$/.test(orderNo)) return 'Invalid order number.';
  db.prepare('SELECT status FROM orders WHERE order_no = ?').get(orderNo);
}
