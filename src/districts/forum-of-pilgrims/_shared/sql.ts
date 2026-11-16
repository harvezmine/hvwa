// src/districts/forum-of-pilgrims/_shared/sql.ts — read helper for the forum's SQL labs. Plumbing, not a lesson: the query
// (and its flaw) is in levels/*.ts. No blob hardening here: challengeDb already caps randomblob() and zeroblob() (RECIPES 4).
import type { SQLInputValue, StatementSync } from 'node:sqlite';

/**
 * At most `max` rows of `stmt`, read one at a time with iterate() and stopped there: the result cap where the player
 * controls the query (rule (g)). A SQL LIMIT is no cap, because an injected comment removes it.
 */
export function firstRows(stmt: StatementSync, max: number, ...params: SQLInputValue[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  if (max <= 0) return rows;
  for (const row of stmt.iterate(...params)) {
    rows.push(row);
    if (rows.length >= max) break;
  }
  return rows;
}

/** A result cell as display text, at most `n` characters (default 200). Display only. */
export function cell(v: unknown, n = 200): string {
  const s = String(v ?? '');
  return s.length > n ? s.slice(0, n) : s;
}
