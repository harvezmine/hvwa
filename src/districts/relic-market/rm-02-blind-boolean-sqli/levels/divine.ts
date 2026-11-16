import type { ChallengeDb } from '../../../../core/challenge-db.js';
import { REGIONS } from '../model.js';

// DIVINE — secure reference: every input channel is a bound parameter, the cookie included, and the region is an
// allowlist (eu, us, apac; anything else is the default, eu). The answers are uniform.
// ASVS 5.0 V1.2 (parameterized queries for every input channel, cookies and headers included).
//
// Errors, and why this lab differs from "the real message below Divine" (decision Q4): a BLIND lab hides database
// errors at EVERY level, not only here. The route turns any database error into the level's normal negative answer
// ("Not available."), because an echoed SQLite message would make the lab no longer blind: it would be an error-based
// oracle. That is deliberate, so the generic-error rule changes nothing at this level.
// Out of scope here: a production stock checker would also rate-limit lookups.
export function region(raw: string): string {
  return REGIONS.find((r) => r === raw) ?? 'eu';
}

export function inStock(db: ChallengeDb, sku: string, region: string): boolean {
  const row = db.prepare('SELECT qty FROM stock WHERE sku = ? AND region = ?').get(sku, region);
  return row !== undefined && Number(row.qty) > 0;
}
