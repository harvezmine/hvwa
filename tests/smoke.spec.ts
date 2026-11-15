import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';

describe('smoke', () => {
  it('GET /healthz returns ok', async () => {
    const res = await request(createApp()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('createApp({ dbPath }) uses a persistent, migrated + seeded database file', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'hvwa-db-')), 'hvwa.db');
    createApp({ dbPath, flagSecret: 'test-secret' });
    expect(existsSync(dbPath)).toBe(true);
    const row = openDb(dbPath).prepare('SELECT role FROM users WHERE username=?').get('templar_admin');
    expect(row).toMatchObject({ role: 'admin' });
  });
});
