import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';

const tempDirs: string[] = [];
afterEach(() => {
  // Safety net if a test fails before its own cleanup.
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

describe('smoke', () => {
  it('GET /healthz returns ok', async () => {
    const res = await request(createApp()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('createApp({ dbPath }) uses a persistent, migrated database file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hvwa-db-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'hvwa.db');
    const app = createApp({ dbPath, flagSecret: 'test-secret' });
    expect(existsSync(dbPath)).toBe(true);

    const check = openDb(dbPath);
    try {
      const names = check.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
      expect(names.map((r) => r.name)).toEqual(['events', 'hint_unlocks', 'solves']);
      expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 });
    } finally {
      check.close();
    }

    // Release the app's handle too, then the temp dir must be removable.
    app.locals.db.close();
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  });
});
