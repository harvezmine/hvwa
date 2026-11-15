// src/core/registry.ts
export type Level = 'acolyte' | 'templar' | 'inquisitor' | 'divine';

export interface HintTier { id: 1 | 2 | 3; text: { id: string; en: string }; cost: number; }

export interface Challenge {
  id: string;                 // e.g. "GK-01"
  district: string;           // e.g. "gatekeeper"
  slug: string;               // url segment, e.g. "sqli-login"
  title: { id: string; en: string };
  summary: { id: string; en: string };
  maps: string[];             // ["A05:2025","CWE-89"]
  levels: Level[];            // which levels are implemented
  points: number;             // base points (scaled by top level solved)
  hints: HintTier[];
  // verify a submitted solution for a given session+level; return true on solve
  check: (ctx: CheckContext) => Promise<boolean> | boolean;
  mount: (router: import('express').Router) => void; // attaches vulnerable routes
}

export interface CheckContext {
  sessionId: string;
  level: Level;
  submission: string;         // flag or answer the player submits
  db: import('node:sqlite').DatabaseSync;
}

export function defineChallenge(input: Omit<Challenge, 'points'> & { points?: number }): Challenge {
  if (!/^[A-Z]{2}-\d{2}$/.test(input.id)) throw new Error(`bad challenge id ${input.id}`);
  if (input.levels.length === 0) throw new Error(`${input.id} has no levels`);
  return { points: 100, ...input };
}

const _all = new Map<string, Challenge>();
export function register(c: Challenge): void {
  if (_all.has(c.id)) throw new Error(`duplicate challenge ${c.id}`);
  _all.set(c.id, c);
}
export function allChallenges(): Challenge[] { return [..._all.values()]; }
export function getChallenge(id: string): Challenge | undefined { return _all.get(id); }
