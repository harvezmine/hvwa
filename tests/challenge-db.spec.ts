import { describe, it, expect } from 'vitest';
import { challengeDb } from '../src/core/challenge-db.js';

const SCHEMA = `
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, role TEXT);
  CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);
`;

describe('challengeDb', () => {
  it('returns an in-memory DB with the given schema and seed applied', () => {
    const db = challengeDb(SCHEMA, (d) => {
      d.prepare('INSERT INTO users (username, role) VALUES (?, ?)').run('templar_admin', 'admin');
    });
    expect(db.prepare('SELECT role FROM users WHERE username=?').get('templar_admin')).toMatchObject({ role: 'admin' });
    expect(db.location()).toBeNull(); // :memory:
  });

  it('works without a seed', () => {
    const db = challengeDb(SCHEMA);
    expect(db.prepare('SELECT COUNT(*) AS c FROM users').get()).toMatchObject({ c: 0 });
  });

  it('every call is a fresh, independent database', () => {
    const a = challengeDb(SCHEMA);
    const b = challengeDb(SCHEMA);
    a.prepare("INSERT INTO notes (body) VALUES ('only in a')").run();
    expect(b.prepare('SELECT COUNT(*) AS c FROM notes').get()).toMatchObject({ c: 0 });
  });

  it('has none of the platform tables', () => {
    const names = challengeDb(SCHEMA).prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(names.map((r) => r.name).sort()).toEqual(['notes', 'users']);
  });

  it('surfaces schema errors', () => {
    expect(() => challengeDb('CREATE TABLE broken (')).toThrow();
  });
});
