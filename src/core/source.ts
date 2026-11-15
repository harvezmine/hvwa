// src/core/source.ts — read a challenge's level source for View Source / Diff.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLevel, type Level } from './levels.js';
import type { Challenge } from './registry.js';

// Level files are static for the life of the process: cache per (dir, level),
// misses included, so GET /c/:id does not re-read every file.
const cache = new Map<string, string | undefined>();

/**
 * Source text of `<c.dir>/levels/<level>.ts`, or undefined when the level is
 * not one the challenge implements or the file is missing/unreadable.
 * SECURITY: the path is built only from the registered c.dir and a level
 * validated against both the level list and c.levels, never from user input.
 */
export function levelSource(c: Pick<Challenge, 'dir' | 'levels'>, level: Level): string | undefined {
  if (!isLevel(level) || !c.levels.includes(level)) return undefined;
  const key = `${c.dir}|${level}`;
  if (cache.has(key)) return cache.get(key);
  let src: string | undefined;
  try {
    src = readFileSync(join(c.dir, 'levels', `${level}.ts`), 'utf8');
  } catch {
    src = undefined;
  }
  cache.set(key, src);
  return src;
}

/** The absolute directory of a challenge module: `dir: challengeDir(import.meta.url)`. */
export function challengeDir(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}

/**
 * Fail fast on a wrong `dir` or a forgotten level file: throws listing every
 * missing `levels/<level>.ts` for the levels the challenge implements.
 */
export function assertChallengeFiles(c: Pick<Challenge, 'id' | 'dir' | 'levels'>): void {
  const missing = c.levels
    .map((l) => join('levels', `${l}.ts`))
    .filter((rel) => !existsSync(join(c.dir, rel)));
  if (missing.length > 0) {
    throw new Error(`challenge ${c.id}: missing level file(s) in ${c.dir}: ${missing.join(', ')}`);
  }
}
