// src/core/fixtures.ts — a lab's fixture lists (wordlists, leaked lists): read from its fixtures/ folder and served
// as text/plain. The one lab helper that reads the real disk, kept apart from core/lab.ts so the per-session engine
// (and everything built on it: core/sim/, core/simfs.ts) never reaches node:fs (tests/sim.spec.ts and
// tests/upload-guard.spec.ts check the import graphs).
import { readFileSync } from 'node:fs';
import type { Response } from 'express';

/**
 * A lab's fixture list (one entry per line, blanks dropped), read lazily once. Resolve the file next to
 * the module with `new URL('./fixtures/x.txt', import.meta.url)`; copy-assets ships fixtures into dist/.
 */
export function fixtureLines(url: URL): () => readonly string[] {
  let lines: readonly string[] | undefined;
  return () => (lines ??= Object.freeze(readFileSync(url, 'utf8').split(/\r?\n/).filter((l) => l !== '')));
}

/** Serve a fixture list from a lab route as text/plain, one entry per line. */
export function sendLines(res: Pick<Response, 'type'>, lines: readonly string[]): void {
  res.type('text/plain').send(`${lines.join('\n')}\n`);
}
