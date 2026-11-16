// model.ts — SC-11's lab state and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import { issueFlag } from '../../../core/flags.js';
import { byLevel, perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { simFs, type SimFile, type SimFs, type SimSeparators } from '../../../core/simfs.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

/** The challenge id the vault's flag is issued under (the same one challenge.ts registers). */
const ID = 'SC-11';
/** The public scrolls' directory, and the vault file outside it that holds this session's flag. */
export const PUBLIC_DIR = '/public';
export const VAULT_FLAG = '/vault/flag.txt';

/** The public scrolls: name and text. The library page lists them in this order. */
export const SCROLLS: readonly (readonly [name: string, text: string])[] = [
  ['psalms.txt', 'Blessed is the pilgrim who keeps the lamp.\nBlessed is the scribe who keeps the page.\n'],
  ['litany.txt', 'For the gate, the vault and the stair, we keep watch.\nFor the ink and the vellum, we keep faith.\n'],
  ['glossary.txt', 'Glossary of the Scriptorium\n  scroll: a page rolled for keeping\n  vault: where the archive keeps what is not for everyone\n'],
];

/** What `read` decides for one requested name: the file the server reads (undefined: no such file), or a refusal. */
export type Read = { readonly ok: true; readonly file: SimFile | undefined } | { readonly ok: false; readonly text: string };

/** What every levels/<level>.ts exports (checked by byLevel<DownloadLevel>). */
export interface DownloadLevel {
  /** The path separators the level's simulated server understands: '/' (POSIX) or '/\\' (Windows-style). */
  readonly separators: SimSeparators;
  /**
   * Find the file for the requested `file` name, exactly as the route got it (Express has already decoded the
   * query string ONCE). How the name becomes a path, and what is refused on the way, is the whole lesson.
   */
  read(fs: SimFs, file: string): Read;
}

export const impl = byLevel<DownloadLevel>({ acolyte, templar, inquisitor, divine });

/** One player's library at one level. */
export interface Library { readonly fs: SimFs }

// One simulated file system per player AND per level: the flag in the vault is issued for exactly that session and level.
// Nothing here can be changed by a player (downloads only read), so there is no Restart lab. Everything is pinned.
const libraries = perSession((level, sessionId): Library => {
  const fs = simFs({ separators: impl.for(level).separators });
  for (const [name, text] of SCROLLS) fs.write(`${PUBLIC_DIR}/${name}`, text, { contentType: 'text/plain', pinned: true });
  // Divine's vault is sealed: the level never issues a flag.
  const vault = level === 'divine' ? 'The vault is sealed.\n' : `${issueFlag(ID, sessionId, level)}\n`;
  fs.write(VAULT_FLAG, vault, { contentType: 'text/plain', pinned: true });
  return { fs };
});

export function labFor(req: { sessionId: string; level: Level }): Library {
  return libraries.for(req);
}
