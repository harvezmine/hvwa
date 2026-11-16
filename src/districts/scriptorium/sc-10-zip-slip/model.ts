// model.ts — SC-10's lab state and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import { byLevel, perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { simFs, type SimFs, type SimSeparators } from '../../../core/simfs.js';
import type { ZipEntry } from '../../../core/upload-zip.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

/** Where the server extracts a restored archive. */
export const RESTORE_DIR = '/srv/app/uploads/restore';
/** The welcome template: outside the restore folder, so only an escaping entry can change it. Its rendering is the proof. */
export const SENTINEL = '/srv/app/templates/welcome.txt';
const WELCOME = 'Welcome, pilgrim.\n';

/** What `extract` decides for one entry: where it was written, or why it was refused. */
export type Extracted = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly text: string };

/** What every levels/<level>.ts exports (checked by byLevel<ZipLevel>). */
export interface ZipLevel {
  /** The path separators the level's simulated server understands: '/' (POSIX) or '/\\' (Windows-style). */
  readonly separators: SimSeparators;
  /** Extract ONE file entry (never a folder) under `dir`, with the level's own join and checks, via `fs.write`. */
  extract(fs: SimFs, dir: string, entry: ZipEntry): Extracted;
}

export const impl = byLevel<ZipLevel>({ acolyte, templar, inquisitor, divine });

/** One player's lab at one level. */
export interface ZipLab { readonly fs: SimFs }

// One simulated server per player AND per level (its separators are the level's). The sentinel is pinned: no number of
// extractions drops it, only an entry that names it overwrites it. No limiter lives here, so Restart lab is safe.
const labs = perSession((level): ZipLab => {
  const fs = simFs({ separators: impl.for(level).separators });
  fs.write(SENTINEL, WELCOME, { contentType: 'text/plain', pinned: true });
  fs.write(`${RESTORE_DIR}/README.txt`, 'Restored files are extracted here.\n', { contentType: 'text/plain', pinned: true });
  return { fs };
});

export function labFor(req: { sessionId: string; level: Level }): ZipLab {
  return labs.for(req);
}

/** The body of the lab's `reset` hook. */
export function resetLab(req: { sessionId: string; level: Level }): void {
  labs.reset(req);
}
