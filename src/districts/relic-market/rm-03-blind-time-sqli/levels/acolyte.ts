import type { ChallengeDb } from '../../../../core/challenge-db.js';

// ACOLYTE — no defense: the order number is concatenated straight into the SQL string.
// Blind and timing-only: the page always gives the same answer, so the only thing an injected condition can change is
// how long the shop takes (the provided sleep(seconds) helper).
export function lookup(db: ChallengeDb, orderNo: string): void {
  db.prepare(`SELECT status FROM orders WHERE order_no = '${orderNo}'`).get(); // the status is emailed, never shown
}
