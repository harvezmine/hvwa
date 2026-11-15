import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';

describe('db', () => {
  it('migrates and seeds the templar admin user', () => {
    const db = openDb(':memory:');
    migrate(db);
    seed(db);
    const row = db.prepare('SELECT username, role FROM users WHERE username=?').get('templar_admin');
    expect(row).toMatchObject({ username: 'templar_admin', role: 'admin' });
  });
});
