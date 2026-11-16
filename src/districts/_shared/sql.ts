// src/districts/_shared/sql.ts — read helpers for the SQL labs of every district (Relic Market, Forum of Pilgrims ...).
// Plumbing, not a lesson: the query (and its flaw) is in levels/*.ts. Not a challenge: never served by View Source.
//
// No blob hardening here: the engine's challengeDb facade already registers capped randomblob() and zeroblob() on
// every challenge DB before the schema and seed run (docs/RECIPES.md section 4, "SQL memory bombs"). A seed must never
// register them again.
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

/**
 * A result cell as display text, at most `n` characters (default 200). Display only: it slices, and a slice may keep its
 * whole parent string alive, so text a lab STORES goes through a copying clip (shop.ts `clipText`, core/sim `clip`).
 */
export function cell(v: unknown, n = 200): string {
  const s = String(v ?? '');
  return s.length > n ? s.slice(0, n) : s;
}
