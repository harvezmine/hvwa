import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { TEST_SECRET } from './helpers.js';

const tempDirs: string[] = [];
const handles: DatabaseSync[] = [];
afterEach(() => {
  // Safety net if a test fails before its own cleanup: close handles first
  // (Windows cannot delete a file SQLite holds open), then remove the dirs.
  for (const h of handles.splice(0)) if (h.isOpen) h.close();
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
    const app = createApp({ dbPath, flagSecret: TEST_SECRET });
    handles.push(app.locals.db);
    expect(existsSync(dbPath)).toBe(true);

    const check = openDb(dbPath);
    handles.push(check);
    const names = check.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    expect(names.map((r) => r.name)).toEqual(['auth_accounts', 'auth_tokens', 'events', 'hint_unlocks', 'solves']);
    expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 });

    // Release both handles, then the temp dir must be removable.
    check.close();
    app.locals.db.close();
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  });
});

describe('createApp flag secret', () => {
  it('rejects an explicit flagSecret shorter than 16 characters', () => {
    expect(() => createApp({ flagSecret: 'test-secret' })).toThrow(/at least 16/);
  });
});
