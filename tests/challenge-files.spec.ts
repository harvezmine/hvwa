import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { challengeDir, assertChallengeFiles } from '../src/core/source.js';
import { allChallenges, defineChallenge } from '../src/core/registry.js';
import { createApp } from '../src/app.js';
import { recordSolve, bestSolve } from '../src/core/scoreboard.js';
import '../src/districts/index.js';

const root = mkdtempSync(join(tmpdir(), 'hvwa-cf-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function chal(levels: ('acolyte' | 'templar' | 'divine')[], files: string[]) {
  const dir = mkdtempSync(join(root, 'c-'));
  mkdirSync(join(dir, 'levels'));
  for (const f of files) writeFileSync(join(dir, 'levels', `${f}.ts`), 'x');
  return defineChallenge({
    id: 'CF-01', district: 'x', slug: 'y', dir, title: { id: 't', en: 't' }, summary: { id: 's', en: 's' },
    maps: [], levels, mount: () => {}, hints: [],
  });
}

describe('challengeDir', () => {
  it('returns the absolute directory of an import.meta.url', () => {
    const url = pathToFileURL(join(root, 'gk-01', 'index.ts')).href;
    const d = challengeDir(url);
    expect(isAbsolute(d)).toBe(true);
    expect(d).toBe(join(root, 'gk-01'));
  });
});

describe('assertChallengeFiles', () => {
  it('passes when every implemented level (divine included) has a file', () => {
    expect(() => assertChallengeFiles(chal(['acolyte', 'divine'], ['acolyte', 'divine']))).not.toThrow();
  });
  it('lists every missing levels/<level>.ts', () => {
    const c = chal(['acolyte', 'templar', 'divine'], ['acolyte']);
    expect(() => assertChallengeFiles(c)).toThrow(/CF-01/);
    expect(() => assertChallengeFiles(c)).toThrow(/templar\.ts/);
    expect(() => assertChallengeFiles(c)).toThrow(/divine\.ts/);
    expect(() => assertChallengeFiles(c)).not.toThrow(/acolyte\.ts/);
  });
  it('every registered challenge ships its level files (catches a wrong dir at CI time)', () => {
    for (const c of allChallenges()) expect(() => assertChallengeFiles(c), c.id).not.toThrow();
  });
});

describe('bestSolve', () => {
  it('returns a validated Level, and undefined for a corrupt stored level', () => {
    const db = createApp().locals.db;
    recordSolve(db, 's1', 'CF-01', 'templar', 150);
    expect(bestSolve(db, 's1', 'CF-01')).toEqual({ level: 'templar', points: 150 });
    db.prepare('UPDATE solves SET level=? WHERE session_id=?').run('bogus', 's1');
    expect(bestSolve(db, 's1', 'CF-01')).toBeUndefined();
    expect(bestSolve(db, 'nobody', 'CF-01')).toBeUndefined();
  });
});
