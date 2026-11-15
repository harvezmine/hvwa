// src/core/source.ts — read a challenge's level source for View Source / Diff.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLevel, type Level } from './levels.js';
import type { Challenge } from './registry.js';

/**
 * Source text of `<c.dir>/levels/<level>.ts`, or undefined when the level is
 * not one the challenge implements or the file is missing/unreadable.
 * SECURITY: the path is built only from the registered c.dir and a level
 * validated against both the level list and c.levels, never from user input.
 */
export function levelSource(c: Pick<Challenge, 'dir' | 'levels'>, level: Level): string | undefined {
  if (!isLevel(level) || !c.levels.includes(level)) return undefined;
  try {
    return readFileSync(join(c.dir, 'levels', `${level}.ts`), 'utf8');
  } catch {
    return undefined;
  }
}
