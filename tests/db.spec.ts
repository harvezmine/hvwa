import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, MIGRATIONS, SCHEMA_VERSION } from '../src/db/index.js';

const userVersion = (db: DatabaseSync) =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

const tables = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
    .map((r) => r.name);

describe('db', () => {
  it('the platform schema holds only platform state: solves, hint_unlocks, events', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(tables(db)).toEqual(['events', 'hint_unlocks', 'solves']);
    expect(columns(db, 'solves')).toEqual(
      expect.arrayContaining(['session_id', 'challenge_id', 'level', 'points', 'solved_at']));
    expect(columns(db, 'hint_unlocks')).toEqual(
      expect.arrayContaining(['session_id', 'challenge_id', 'tier', 'cost']));
  });

  it('takes a version-0 database to the latest version and records it', () => {
    const db = openDb(':memory:');
    expect(userVersion(db)).toBe(0);
    migrate(db);
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    expect(columns(db, 'solves')).toContain('points');
  });

  it('is idempotent: migrating twice keeps data and version', () => {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare("INSERT INTO solves (session_id,challenge_id,level,points,solved_at) VALUES ('s','GK-01','acolyte',100,1)").run();
    db.prepare("INSERT INTO hint_unlocks (session_id,challenge_id,tier,cost) VALUES ('s','GK-01',1,10)").run();
    expect(() => migrate(db)).not.toThrow();
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.prepare('SELECT COUNT(*) c FROM solves').get()).toMatchObject({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM hint_unlocks').get()).toMatchObject({ c: 1 });
  });

  it('applies only the steps above the stored version, in order', () => {
    const db = openDb(':memory:');
    const ran: number[] = [];
    const steps = [
      () => { ran.push(1); },
      (d: DatabaseSync) => { ran.push(2); d.exec('CREATE TABLE t2 (x)'); },
      (d: DatabaseSync) => { ran.push(3); d.exec('CREATE TABLE t3 (x)'); },
    ];
    db.exec('PRAGMA user_version = 1');
    migrate(db, steps);
    expect(ran).toEqual([2, 3]);
    expect(userVersion(db)).toBe(3);
    migrate(db, steps);
    expect(ran).toEqual([2, 3]); // nothing re-run
  });

  it('rolls back every pending step and keeps the version when one fails', () => {
    const db = openDb(':memory:');
    const steps = [
      (d: DatabaseSync) => d.exec('CREATE TABLE a (x)'),
      (d: DatabaseSync) => { d.exec('CREATE TABLE b (x)'); throw new Error('step 2 broke'); },
    ];
    expect(() => migrate(db, steps)).toThrow('step 2 broke');
    expect(userVersion(db)).toBe(0);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(tables).toEqual([]);
  });

  it('surfaces the original error when the transaction is already gone', () => {
    const db = openDb(':memory:');
    const steps = [(d: DatabaseSync) => { d.exec('COMMIT'); throw new Error('the real cause'); }];
    expect(() => migrate(db, steps)).toThrow('the real cause');
    expect(db.isTransaction).toBe(false);
  });

  it('refuses a database newer than this build', () => {
    const db = openDb(':memory:');
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => migrate(db)).toThrow(/newer than this build/i);
    expect(userVersion(db)).toBe(SCHEMA_VERSION + 1);
  });

  it('openDb requires an explicit path', () => {
    expect(() => openDb('')).toThrow(/path/i);
  });
});

describe('file databases', () => {
  const dirs: string[] = [];
  const open: DatabaseSync[] = [];
  afterEach(() => {
    for (const d of open.splice(0)) if (d.isOpen) d.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('open in WAL mode with a 5 s busy timeout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hvwa-wal-'));
    dirs.push(dir);
    const db = openDb(join(dir, 'p.db'));
    open.push(db);
    expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 });
  });

  it(':memory: databases are left alone', () => {
    const db = openDb(':memory:');
    expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'memory' });
  });
});
