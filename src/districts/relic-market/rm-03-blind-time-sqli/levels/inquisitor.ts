import type { ChallengeDb } from '../../../../core/challenge-db.js';

// INQUISITOR — real defense, subtly wrong: an allowlist regex. But it has the multiline flag, so ^ and $ match at LINE
// boundaries: the input only needs ONE line that looks like an order number, and the rest of the input (a second
// line) goes into the SQL, which is still built by concatenation.
export function lookup(db: ChallengeDb, orderNo: string): void | string {
  if (!/^RM-\d{4}$/m.test(orderNo)) return 'Invalid order number.';
  db.prepare(`SELECT status FROM orders WHERE order_no = '${orderNo}'`).get();
}
