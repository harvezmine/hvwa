// src/core/challenge-db.ts — challenge-side data, kept apart from the platform DB.
import { DatabaseSync, type StatementSync } from 'node:sqlite';

/**
 * What challenge code gets: ONE method, prepare(sql), for a single statement.
 * No exec() (no stacked queries), no close(), no extension loading, no access
 * to the underlying DatabaseSync.
 */
export interface ChallengeDb {
  prepare(sql: string): StatementSync;
}

// Fail closed: only these first keywords may run. Everything else (ATTACH,
// DETACH, PRAGMA, VACUUM, BEGIN/COMMIT, ANALYZE, REINDEX, ... and anything
// unrecognised, including '') is rejected.
const ALLOWED = new Set([
  'SELECT', 'VALUES', 'WITH', 'INSERT', 'REPLACE', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER',
]);

/**
 * The first SQL keyword SQLite would execute, uppercased ('' if none). Skips
 * what SQLite's tokenizer skips before a statement: ASCII whitespace
 * plus U+FEFF (SQLite treats a BOM as whitespace anywhere), `-- …` line comments, `/* … *\/` block comments (unterminated = to EOF) and
 * empty statements (`;`). EXPLAIN [QUERY PLAN] is looked through.
 */
export function firstKeyword(sql: string): string {
  let i = 0;
  const skipNoise = () => {
    for (;;) {
      while (i < sql.length && /[ \t\n\f\r;﻿]/.test(sql[i])) i++;
      if (sql.startsWith('--', i)) {
        const nl = sql.indexOf('\n', i);
        i = nl === -1 ? sql.length : nl + 1;
      } else if (sql.startsWith('/*', i)) {
        const end = sql.indexOf('*/', i + 2);
        i = end === -1 ? sql.length : end + 2;
      } else {
        return;
      }
    }
  };
  const word = () => {
    skipNoise();
    const m = /^[A-Za-z_]+/.exec(sql.slice(i));
    if (!m) return '';
    i += m[0].length;
    return m[0].toUpperCase();
  };
  let kw = word();
  if (kw === 'EXPLAIN') {
    kw = word();
    if (kw === 'QUERY') { word(); kw = word(); } // QUERY PLAN <stmt>
  }
  return kw;
}

/**
 * A fresh, private in-memory database for one challenge's vulnerable data
 * (users, products, orders, ...), returned as a prepare()-only facade.
 *
 * GUARANTEED: the platform DB (solves, hints, events) is a different
 * connection and is never reachable from here. prepare() is an ALLOWLIST: the
 * statement's first keyword (case-insensitive, after whitespace including
 * U+FEFF, comments, empty `;` statements and EXPLAIN [QUERY PLAN]) must be one
 * of SELECT, VALUES, WITH, INSERT, REPLACE, UPDATE, DELETE, CREATE, DROP,
 * ALTER. Anything else — ATTACH, DETACH, PRAGMA, VACUUM, BEGIN/COMMIT,
 * ANALYZE, REINDEX, or an unrecognised/empty statement — is rejected, so
 * injected SQL cannot attach, create or overwrite files or change engine
 * settings. Only the first statement of a prepare() string is ever executed
 * (SQLite ignores the tail), and exec() is not exposed, so there are no
 * stacked queries; load_extension() stays disabled.
 *
 * NOT GUARANTEED: anything inside this DB. Injected SQL can read, change or
 * drop the challenge's own tables — that is the point of the lab. Code that
 * holds the raw handle (the seed callback) is trusted and unrestricted.
 *
 * NOT GUARANTEED: availability. DatabaseSync is synchronous and node:sqlite
 * (Node 22) has no query timeout or progress handler, so an injected unbounded
 * query (e.g. a recursive CTE) can block the whole server. Time-based labs
 * must simulate delay (e.g. `await` a timer when a condition holds) instead
 * of running heavy queries.
 *
 * Call once at module level in the challenge's routes.ts and close over the
 * facade in handlers and in a custom check():
 *
 *   const db = challengeDb(SCHEMA, (raw) => { raw.exec(SEED_SQL); });
 */
export function challengeDb(schemaSql: string, seed?: (db: DatabaseSync) => void): ChallengeDb {
  const raw = new DatabaseSync(':memory:', { allowExtension: false });
  raw.exec(schemaSql);
  seed?.(raw);
  return Object.freeze({
    prepare(sql: string): StatementSync {
      const kw = firstKeyword(sql);
      if (!ALLOWED.has(kw)) throw new Error(`${kw || 'This statement'} is not allowed in a challenge DB`);
      return raw.prepare(sql);
    },
  });
}
