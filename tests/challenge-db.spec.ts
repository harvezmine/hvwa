import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CHALLENGE_BLOB_CAP, challengeDb, firstKeyword } from '../src/core/challenge-db.js';

const SCHEMA = `
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, role TEXT);
  CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);
`;

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'hvwa-cdb-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** SQL string literal for a path (forward slashes; SQLite accepts them on Windows). */
const lit = (p: string) => `'${p.split('\\').join('/')}'`;

describe('challengeDb', () => {
  it('returns a facade over an in-memory DB with the schema and seed applied', () => {
    let location: string | null | undefined;
    const db = challengeDb(SCHEMA, (raw) => {
      raw.prepare('INSERT INTO users (username, role) VALUES (?, ?)').run('templar_admin', 'admin');
      location = raw.location();
    });
    expect(location).toBeNull(); // :memory:
    expect(db.prepare('SELECT role FROM users WHERE username=?').get('templar_admin')).toMatchObject({ role: 'admin' });
  });

  it('works without a seed, and normal SELECT/INSERT/UPDATE/WITH work', () => {
    const db = challengeDb(SCHEMA);
    db.prepare("INSERT INTO notes (body) VALUES ('hi')").run();
    db.prepare("UPDATE notes SET body = 'attach is just a word here'").run();
    expect(db.prepare('WITH n AS (SELECT body FROM notes) SELECT body FROM n').get())
      .toMatchObject({ body: 'attach is just a word here' });
    expect(db.prepare("SELECT 'ATTACH DATABASE x AS y' AS s").get()).toMatchObject({ s: 'ATTACH DATABASE x AS y' });
  });

  it('every call is a fresh, independent database', () => {
    const a = challengeDb(SCHEMA);
    const b = challengeDb(SCHEMA);
    a.prepare("INSERT INTO notes (body) VALUES ('only in a')").run();
    expect(b.prepare('SELECT COUNT(*) AS c FROM notes').get()).toMatchObject({ c: 0 });
  });

  it('exposes only prepare(): no exec, close, loadExtension or raw handle', () => {
    const db = challengeDb(SCHEMA);
    expect(Object.keys(db)).toEqual(['prepare']);
    for (const k of ['exec', 'close', 'loadExtension', 'enableLoadExtension', 'location', 'function']) {
      expect(k in db, k).toBe(false);
    }
    expect(Object.isFrozen(db)).toBe(true);
  });

  it('surfaces schema errors', () => {
    expect(() => challengeDb('CREATE TABLE broken (')).toThrow();
  });
});

describe('challengeDb rejects statements that escape the sandbox', () => {
  const variants = (target: string): string[] => [
    `ATTACH DATABASE ${target} AS x`,
    `attach database ${target} as x`,
    `  \n\t ATTACH ${target} AS x`,
    `-- comment\nATTACH DATABASE ${target} AS x`,
    `/* block */ ATTACH DATABASE ${target} AS x`,
    `/* a */ -- b\n /*c*/ATTACH DATABASE ${target} AS x`,
    `;ATTACH DATABASE ${target} AS x`,
    ` ; ; /*x*/ ; ATTACH DATABASE ${target} AS x`,
    `EXPLAIN ATTACH DATABASE ${target} AS x`,
    `explain query plan ATTACH DATABASE ${target} AS x`,
  ];

  it('rejects ATTACH via prepare (incl. comment / semicolon / EXPLAIN-prefixed) and creates no file', () => {
    const dir = tempDir();
    const db = challengeDb(SCHEMA);
    variants(lit(join(dir, 'evil.db'))).forEach((sql) => {
      expect(() => db.prepare(sql), sql).toThrow(/not allowed in a challenge DB/);
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([
    ['DETACH DATABASE main', 'DETACH'],
    ['PRAGMA writable_schema = 1', 'PRAGMA'],
    ['  pragma table_info(users)', 'PRAGMA'],
    ['/* x */ VACUUM', 'VACUUM'],
  ])('rejects %j', (sql, keyword) => {
    expect(() => challengeDb(SCHEMA).prepare(sql)).toThrow(new RegExp(`${keyword} is not allowed`));
  });

  it('rejects VACUUM INTO and creates no file', () => {
    const dir = tempDir();
    expect(() => challengeDb(SCHEMA).prepare(`VACUUM INTO ${lit(join(dir, 'copy.db'))}`)).toThrow(/VACUUM/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('extension loading stays disabled', () => {
    expect(() => challengeDb(SCHEMA).prepare("SELECT load_extension('x')").get()).toThrow(/not authorized/);
  });

  it('the seed callback still gets the raw handle', () => {
    let raw: DatabaseSync | undefined;
    challengeDb(SCHEMA, (d) => { raw = d; d.exec('PRAGMA user_version = 7'); });
    expect(typeof raw?.exec).toBe('function');
  });
});

describe('challengeDb: BOM (U+FEFF) is whitespace to SQLite and must not bypass the facade', () => {
  const B = '\uFEFF';
  const bomVariants = (target: string): string[] => [
    `${B}ATTACH ${target} AS p`,
    `${B}${B}ATTACH ${target} AS p`,
    `;${B}ATTACH ${target} AS p`,
    `/* c */${B}ATTACH ${target} AS p`,
    ` ${B} ATTACH ${target} AS p`,
    `${B}attach ${target} AS p`,
    `${B}EXPLAIN${B}ATTACH ${target} AS p`,
    `${B}PRAGMA user_version`,
  ];

  it('rejects every BOM variant and creates no file', () => {
    const dir = tempDir();
    const target = join(dir, 'evil.db');
    const db = challengeDb(SCHEMA);
    for (const sql of bomVariants(lit(target))) {
      expect(() => db.prepare(sql), JSON.stringify(sql)).toThrow(/not allowed in a challenge DB/);
    }
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a BOM-prefixed SELECT still works', () => {
    const db = challengeDb(SCHEMA);
    expect(db.prepare(`${B}SELECT 1 AS one`).get()).toMatchObject({ one: 1 });
    expect(db.prepare(`${B}${B} /* x */ ${B}SELECT 2 AS two`).get()).toMatchObject({ two: 2 });
  });
});

describe('challengeDb allowlist (fail closed)', () => {
  it.each([
    'BEGIN', 'COMMIT', 'SAVEPOINT x', 'RELEASE x', 'ROLLBACK', 'REINDEX', 'ANALYZE', 'foo',
    'foo bar', '', '   ', '-- only a comment', '/* only a comment */', ';;;', '1', '(SELECT 1)',
  ])('rejects %j', (sql) => {
    expect(() => challengeDb(SCHEMA).prepare(sql)).toThrow(/not allowed in a challenge DB/);
  });

  it('every allowlisted keyword works for a normal statement', () => {
    const db = challengeDb(SCHEMA);
    const stmts = [
      'SELECT 1',
      'VALUES (1), (2)',
      'WITH x AS (SELECT 1 AS a) SELECT a FROM x',
      "INSERT INTO notes (id, body) VALUES (1, 'a')",
      "REPLACE INTO notes (id, body) VALUES (1, 'b')",
      "UPDATE notes SET body = 'c'",
      'DELETE FROM notes',
      'CREATE TABLE t2 (a INTEGER)',
      'ALTER TABLE t2 ADD COLUMN b TEXT',
      'DROP TABLE t2',
      'explain query plan select 1',
    ];
    for (const sql of stmts) expect(() => db.prepare(sql).all(), sql).not.toThrow();
  });
});

describe('challengeDb rejects CREATE VIRTUAL TABLE (shadow-table corruption class)', () => {
  it.each([
    'CREATE VIRTUAL TABLE t USING fts5(x)',
    'create virtual table t using fts4(x)',
    'CREATE TEMP VIRTUAL TABLE t USING fts5(x)',
    'create temporary virtual table t using rtree(id, a, b)',
    'CREATE /* c */ VIRTUAL TABLE t USING fts5(x)',
    'CREATE -- c\n VIRTUAL TABLE t USING fts5(x)',
    'CREATE\uFEFFVIRTUAL TABLE t USING fts5(x)',
    '\uFEFFCREATE TEMP\uFEFF/* c */\uFEFFVIRTUAL TABLE t USING fts5(x)',
    'EXPLAIN CREATE VIRTUAL TABLE t USING fts5(x)',
  ])('rejects %j', (sql) => {
    expect(() => challengeDb(SCHEMA).prepare(sql)).toThrow(/not allowed in a challenge DB/);
  });

  it('normal CREATE TABLE / INDEX / VIEW / TRIGGER / TEMP TABLE still work', () => {
    const db = challengeDb(SCHEMA);
    for (const sql of [
      'CREATE TABLE t2 (a INTEGER)',
      'CREATE TEMP TABLE t3 (a INTEGER)',
      'CREATE INDEX i2 ON notes (body)',
      'CREATE VIEW v2 AS SELECT 1 AS a',
      'CREATE TRIGGER tr2 AFTER INSERT ON notes BEGIN SELECT 1; END',
    ]) expect(() => db.prepare(sql).run(), sql).not.toThrow();
  });

  it('a virtual table created by the seed callback is still queryable via the facade', () => {
    const db = challengeDb(SCHEMA, (raw) => {
      raw.exec("CREATE VIRTUAL TABLE docs USING fts5(body); INSERT INTO docs (body) VALUES ('hello world')");
    });
    expect(db.prepare("SELECT body FROM docs WHERE docs MATCH 'hello'").get()).toMatchObject({ body: 'hello world' });
  });
});

// The cap removes the textbook randomblob payload and the heavy-query timing trick. It does not make every single call
// memory-safe (printf widths, replace(), group_concat over a recursive CTE): an accepted self-DoS gap, RECIPES section 4.
describe('challengeDb caps randomblob() and zeroblob() (the textbook payload and the heavy-query timing trick)', () => {
  const one = (sql: string): unknown => (challengeDb(SCHEMA).prepare(sql).get() as { n?: unknown } | undefined)?.n;

  it('an injected length(randomblob(900000000)) returns at most the cap, and does not allocate it', () => {
    const peakKb = () => process.resourceUsage().maxRSS; // the process's peak resident set so far, in KiB
    const before = peakKb();
    expect(one('SELECT length(randomblob(900000000)) AS n')).toBe(CHALLENGE_BLOB_CAP);
    expect(peakKb() - before).toBeLessThan(100 * 1024); // the built-in would have touched ~900 MB
  });

  it('a size beyond SQLite\'s own limit is capped as well, never even attempted ("string or blob too big")', () => {
    for (const fn of ['randomblob', 'zeroblob']) {
      expect(one(`SELECT length(${fn}(1000000000000)) AS n`), fn).toBe(CHALLENGE_BLOB_CAP);
      expect(one(`SELECT length(${fn}(9223372036854775807)) AS n`), fn).toBe(CHALLENGE_BLOB_CAP);
    }
  });

  it('a zeroblob() that gets materialized (hex, concatenation) is capped too', () => {
    expect(one('SELECT length(hex(zeroblob(900000000))) AS n')).toBe(2 * CHALLENGE_BLOB_CAP);
    // || makes text, and length() of text stops at the first NUL: count the bytes as a blob
    expect(one("SELECT length(CAST(zeroblob(900000000) || 'x' AS BLOB)) AS n")).toBe(CHALLENGE_BLOB_CAP + 1);
  });

  it('below the cap they behave as SQLite\'s: exact sizes, random or zero bytes, the same rules for odd sizes', () => {
    const db = challengeDb(SCHEMA);
    expect(db.prepare(`SELECT length(randomblob(16)) a, length(randomblob(${CHALLENGE_BLOB_CAP})) b, length(randomblob(0)) c,
      length(randomblob(-5)) d, length(randomblob(NULL)) e, length(randomblob('7')) f, length(randomblob(2.9)) g,
      typeof(randomblob(4)) h, length(zeroblob(5)) i, hex(zeroblob(3)) j, length(zeroblob(-1)) k, length(zeroblob(NULL)) l`).get())
      .toEqual({ a: 16, b: CHALLENGE_BLOB_CAP, c: 1, d: 1, e: 1, f: 7, g: 2, h: 'blob', i: 5, j: '000000', k: 0, l: 0 });
    expect(db.prepare('SELECT randomblob(16) = randomblob(16) AS same').get()).toEqual({ same: 0 }); // never constant-folded
    expect(db.prepare('SELECT count(DISTINCT hex(randomblob(8))) AS n FROM (SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3)').get()).toEqual({ n: 3 });
  });

  it('every challenge DB has them, inside views and triggers as well, and so does its seed', () => {
    let seeded: unknown;
    const db = challengeDb(SCHEMA, (raw) => { seeded = (raw.prepare('SELECT length(randomblob(900000000)) AS n').get() as { n: unknown }).n; });
    expect(seeded).toBe(CHALLENGE_BLOB_CAP);
    db.prepare('CREATE VIEW bomb AS SELECT length(zeroblob(900000000)) AS n').run();
    expect(db.prepare('SELECT n FROM bomb').get()).toEqual({ n: CHALLENGE_BLOB_CAP });
    db.prepare("CREATE TRIGGER t AFTER INSERT ON notes BEGIN UPDATE notes SET body = hex(randomblob(900000000)) WHERE id = new.id; END").run();
    db.prepare("INSERT INTO notes (body) VALUES ('x')").run();
    expect(db.prepare('SELECT length(body) AS n FROM notes').get()).toEqual({ n: 2 * CHALLENGE_BLOB_CAP });
  });
});

describe('firstKeyword', () => {
  it.each([
    ['SELECT 1', 'SELECT'],
    ['  -- c\n /* d */ insert into t values (1)', 'INSERT'],
    [';;  ;with x as (select 1) select * from x', 'WITH'],
    ['EXPLAIN QUERY PLAN pragma x', 'PRAGMA'],
    ['/* unterminated', ''],
    ['', ''],
  ])('%j → %j', (sql, kw) => {
    expect(firstKeyword(sql)).toBe(kw);
  });
});
