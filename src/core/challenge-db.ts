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

// Statements that reach outside this private :memory: database or reconfigure
// SQLite: ATTACH/DETACH open or drop other database files (ATTACH creates
// them), PRAGMA changes engine settings, VACUUM INTO writes a file.
const BLOCKED = new Set(['ATTACH', 'DETACH', 'PRAGMA', 'VACUUM']);

/**
 * The first SQL keyword SQLite would execute, uppercased ('' if none). Skips
 * what SQLite's tokenizer skips before a statement: ASCII whitespace,
 * `-- …` line comments, `/* … *\/` block comments (unterminated = to EOF) and
 * empty statements (`;`). EXPLAIN [QUERY PLAN] is looked through.
 */
export function firstKeyword(sql: string): string {
  let i = 0;
  const skipNoise = () => {
    for (;;) {
      while (i < sql.length && /[ \t\n\f\r;]/.test(sql[i])) i++;
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
 * connection and is never reachable from here; prepare() rejects ATTACH,
 * DETACH, PRAGMA and VACUUM (including when hidden behind whitespace,
 * comments, empty `;` statements or EXPLAIN), so injected SQL cannot attach,
 * create or overwrite files or change engine settings; only the first
 * statement of a prepare() string is ever executed (SQLite ignores the
 * tail), and exec() is not exposed, so there are no stacked queries;
 * load_extension() stays disabled.
 *
 * NOT GUARANTEED: anything inside this DB. Injected SQL can read, change or
 * drop the challenge's own tables — that is the point of the lab. Code that
 * holds the raw handle (the seed callback) is trusted and unrestricted.
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
      if (BLOCKED.has(kw)) throw new Error(`${kw} is not allowed in a challenge DB`);
      return raw.prepare(sql);
    },
  });
}
