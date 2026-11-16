// src/districts/_shared/sql.spec.ts — the capped row reader and the cell text helper every SQL lab of every district uses.
import { describe, it, expect } from 'vitest';
import { challengeDb } from '../../core/challenge-db.js';
import { cell, firstRows } from './sql.js';

describe('firstRows', () => {
  const db = challengeDb('CREATE TABLE t (n INTEGER)', (raw) => {
    const ins = raw.prepare('INSERT INTO t (n) VALUES (?)');
    for (let i = 1; i <= 100; i++) ins.run(i);
  });

  it('stops reading at max (the cap where the player controls the query), with bound parameters', () => {
    const stmt = db.prepare('SELECT n FROM t WHERE n > ? ORDER BY n');
    expect(firstRows(stmt, 3, 10)).toEqual([{ n: 11 }, { n: 12 }, { n: 13 }]);
    expect(firstRows(stmt, 0, 10)).toEqual([]);
    expect(firstRows(stmt, -5, 10)).toEqual([]);
    expect(firstRows(stmt, 500, 98)).toEqual([{ n: 99 }, { n: 100 }]);
    expect(firstRows(db.prepare('SELECT n FROM t'), 50)).toHaveLength(50); // the statement is reusable after an early stop
  });

  it('really stops: a query with a huge result yields exactly max rows (the break, not just a slice)', () => {
    const huge = db.prepare('WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 200000) SELECT n FROM c');
    const rows = firstRows(huge, 3);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3]);
    expect(firstRows(huge, 1)).toEqual([{ n: 1 }]);
  });

  it('returns exactly max rows when the result has exactly max rows, and fewer when it has fewer', () => {
    const stmt = db.prepare('SELECT n FROM t WHERE n <= ?');
    expect(firstRows(stmt, 5, 5)).toHaveLength(5);
    expect(firstRows(stmt, 5, 4)).toHaveLength(4);
  });
});

describe('cell', () => {
  it('a result cell as text, at most n characters (default 200)', () => {
    expect(cell('x'.repeat(300))).toHaveLength(200);
    expect(cell('x'.repeat(200))).toHaveLength(200);
    expect(cell('x'.repeat(201))).toBe('x'.repeat(200));
    expect(cell('abcdef', 3)).toBe('abc');
    expect(cell('abc', 3)).toBe('abc');
    expect(cell('abcdef', 0)).toBe('');
    expect(cell(null)).toBe('');
    expect(cell(undefined)).toBe('');
    expect(cell(42)).toBe('42');
  });
});
