// src/core/simfs.ts — the upload labs' simulated filesystem and simulated interpreter (SC-05, SC-07 ... SC-11).
//
// simFs(): one in-memory file system per player and level, made in the lab's perSession factory (it throws anywhere
// else) like GK-06's `files` map, but bounded (SIMFS_LIMITS) and weighed in the process-wide byte budget of large lab
// state that the simulated victim worlds share (capPerSessionHolder, CAPPED_BUDGET_BYTES in core/lab.ts). Nothing touches the
// real disk: paths are keys in a Map. Every path goes through one documented resolver, the simulated OS's ground
// truth (resolveSimPath), so a level's own (flawed) check on a filename is measured against where the write really
// lands, as classifySimUrl is for URLs.
//
// simInterpret(): the "webshell". NOTHING EXECUTES (owner decision Q7): it pattern-matches one statement.
//
// Pure: no real filesystem, no network. Its only runtime imports are node:buffer, core/lab.ts (capPerSessionHolder),
// core/sim/limits.ts and core/upload.ts (tests/upload-guard.spec.ts).
import { Buffer } from 'node:buffer';
import { capPerSessionHolder } from './lab.js';
import { SIM_LIMITS, clip } from './sim/limits.js';
import { ownBytes } from './upload.js';

/**
 * Bounds of one simulated file system. Worst case per instance, measured with a full GC (tests/simfs.spec.ts): the
 * 256 KiB of data plus about 1.8 KiB per file of path, content type and bookkeeping, ~315 KiB (512-character
 * two-byte paths; short ASCII names: ~270 KiB). It weighs `weight` in the byte budget it shares with the victim
 * worlds (96 MiB: about 280 full file systems, or fewer next to worlds).
 */
export const SIMFS_LIMITS = Object.freeze({
  /** Most files; beyond it the oldest unpinned file is dropped. */
  files: 32,
  /** Largest file, in bytes (a bigger write is refused). */
  fileBytes: 128 * 1024,
  /** All files together, in bytes; beyond it the oldest unpinned files are dropped. */
  totalBytes: 256 * 1024,
  /** Longest path handed to any call, in UTF-16 code units (it bounds the nesting depth too). */
  pathLength: 512,
  /** Longest content type kept (a longer one is clipped). */
  contentTypeLength: 255,
  /** What one instance weighs in the shared byte budget: the measured worst case plus ~10%, rounded up to 32 KiB. */
  weight: 352 * 1024,
});

/** Thrown for a path or write the simulated file system refuses. Lab-visible below Divine through tryDb. */
export class SimFsError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'SimFsError';
  }
}

/** Which characters the simulated OS splits paths on: POSIX `/` only (the default), or `/` and `\` (Windows-style). */
export type SimSeparators = '/' | '/\\';

export interface SimFsOptions {
  /** '/\\' for a lab whose server treats a backslash as a separator (SC-10, SC-11 Inquisitor). Default '/'. */
  readonly separators?: SimSeparators;
}

/** One stored file, frozen. `bytes` is the file system's own copy: read it, never change it. */
export interface SimFile {
  /** The resolved path (resolveSimPath). */
  readonly path: string;
  readonly bytes: Buffer;
  /** The content type the lab stored with it (the uploader's claim, or one the lab chose). */
  readonly contentType: string;
  /** A pinned file (a lab's seed: a sentinel, a secret) is never dropped to make room; it can still be overwritten. */
  readonly pinned: boolean;
}

export interface SimWriteOptions {
  /** Default 'application/octet-stream'. */
  readonly contentType?: string;
  /** Default: the overwritten file's pin, else false. */
  readonly pinned?: boolean;
}

export interface SimFs {
  readonly separators: SimSeparators;
  /** resolveSimPath with this file system's separators: what a Divine containment check compares. */
  resolve(path: string): string;
  /** The file at `path`, or undefined (also for a directory, or a path too long to exist). */
  read(path: string): SimFile | undefined;
  has(path: string): boolean;
  /**
   * Store a copy of `data` (bytes, or a string as UTF-8) at the resolved path, replacing any file there. If the
   * file system would then hold more than SIMFS_LIMITS.files files or totalBytes bytes, the oldest unpinned files
   * are dropped first. Throws SimFsError (and changes nothing) for the root, a path over pathLength, a file over
   * fileBytes, or no room even after dropping every unpinned file.
   */
  write(path: string, data: Uint8Array | string, opts?: SimWriteOptions): SimFile;
  delete(path: string): boolean;
  /** Files under `dir` (default: all), oldest write first. A directory is a key prefix: there are no empty ones. */
  list(dir?: string): readonly SimFile[];
  /** Files held. */
  readonly size: number;
  /** Bytes held. */
  readonly bytes: number;
}

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

function checkSeparators(separators: unknown): SimSeparators {
  if (separators !== '/' && separators !== '/\\') throw new Error(`simFs: separators must be '/' or '/\\\\' (got ${JSON.stringify(separators)})`);
  return separators;
}

/**
 * The simulated OS's path rules, the ground truth of where a path lands: split on the separators (`/`, plus `\` on a
 * '/\\' file system), drop empty and `.` segments, let `..` remove the segment before it (never climbing above the
 * root, as POSIX), and join from the root, so the result is always absolute (`a/b` is `/a/b`). Nothing else changes:
 * case, NUL, trailing dots and spaces and percent sequences are kept (`....` and `..b` are ordinary names). A lab that
 * decodes or truncates a name does it in its level file, where View Source shows it. Throws SimFsError for a path
 * longer than SIMFS_LIMITS.pathLength. The result is its own copy.
 */
export function resolveSimPath(path: string, separators: SimSeparators = '/'): string {
  checkSeparators(separators);
  if (typeof path !== 'string') throw new SimFsError('a path must be a string');
  if (path.length > SIMFS_LIMITS.pathLength) throw new SimFsError(`the path is longer than ${SIMFS_LIMITS.pathLength} characters`);
  const out: string[] = [];
  for (const segment of path.split(separators === '/' ? '/' : /[\\/]/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  const key = `/${out.join('/')}`;
  // A relative path gains its leading `/`: the resolved key is checked as well, never cut short.
  if (key.length > SIMFS_LIMITS.pathLength) throw new SimFsError(`the path is longer than ${SIMFS_LIMITS.pathLength} characters once resolved`);
  return clip(key, key.length); // a copy (never a view of the caller's string), whole
}

/**
 * One player's simulated file system at one level. Call it inside the lab's perSession factory, next to the rest of
 * that lab's state, and seed it there (pinned files for what the lab depends on):
 *
 *   const labs = perSession((): LabState => {
 *     const fs = simFs();
 *     fs.write('/srv/app/templates/welcome.txt', 'Welcome, pilgrim.', { contentType: 'text/plain', pinned: true });
 *     return { fs };
 *   });
 *
 * It caps that holder like a victim world: at most SIM_LIMITS.newWorldsPerMinute new instances a minute, and the
 * instance weighs SIMFS_LIMITS.weight in the process-wide byte budget (an eviction there is a reset of that player's
 * lab).
 */
export function simFs(opts: SimFsOptions = {}): SimFs {
  capPerSessionHolder('simFs', { maxNewPerMinute: SIM_LIMITS.newWorldsPerMinute, weight: SIMFS_LIMITS.weight });
  const separators = checkSeparators(opts.separators ?? '/');
  const files = new Map<string, SimFile>(); // insertion order = oldest write first
  let used = 0;
  const lookup = (path: string): string | undefined => {
    try { return resolveSimPath(path, separators); } catch (err) { if (err instanceof SimFsError) return undefined; throw err; }
  };
  return Object.freeze({
    separators,
    resolve: (path: string) => resolveSimPath(path, separators),
    read(path: string): SimFile | undefined {
      const key = lookup(path);
      return key === undefined ? undefined : files.get(key);
    },
    has(path: string): boolean {
      const key = lookup(path);
      return key !== undefined && files.has(key);
    },
    write(path: string, data: Uint8Array | string, w: SimWriteOptions = {}): SimFile {
      const key = resolveSimPath(path, separators);
      if (key === '/') throw new SimFsError('cannot write to the root directory');
      if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw new SimFsError('a file holds bytes or a string');
      // The size first, from the byte length: an over-size write is refused before anything is copied.
      const size = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength;
      if (size > SIMFS_LIMITS.fileBytes) throw new SimFsError(`the file is too large (${size} bytes; at most ${SIMFS_LIMITS.fileBytes})`);
      const bytes = ownBytes(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
      const prev = files.get(key);
      // Decide what goes before changing anything: a refused write leaves the file system as it was.
      let count = files.size + (prev === undefined ? 1 : 0);
      let total = used - (prev?.bytes.length ?? 0) + bytes.length;
      const drop: SimFile[] = [];
      for (const f of files.values()) {
        if (count <= SIMFS_LIMITS.files && total <= SIMFS_LIMITS.totalBytes) break;
        if (f.pinned || f.path === key) continue;
        drop.push(f);
        count--;
        total -= f.bytes.length;
      }
      if (count > SIMFS_LIMITS.files || total > SIMFS_LIMITS.totalBytes) {
        throw new SimFsError('the simulated file system is full (its pinned files leave no room for this one)');
      }
      for (const f of drop) files.delete(f.path);
      files.delete(key); // re-inserted below: the newest write
      const contentType = typeof w.contentType === 'string' ? w.contentType : DEFAULT_CONTENT_TYPE;
      const file: SimFile = Object.freeze({
        path: key, bytes, contentType: clip(contentType, SIMFS_LIMITS.contentTypeLength), pinned: w.pinned ?? prev?.pinned ?? false,
      });
      files.set(key, file);
      used = total;
      return file;
    },
    delete(path: string): boolean {
      const key = lookup(path);
      const f = key === undefined ? undefined : files.get(key);
      if (f === undefined) return false;
      files.delete(f.path);
      used -= f.bytes.length;
      return true;
    },
    list(dir = '/'): readonly SimFile[] {
      const base = lookup(dir);
      if (base === undefined) return Object.freeze([]);
      const prefix = base === '/' ? '/' : `${base}/`;
      return Object.freeze([...files.values()].filter((f) => f.path.startsWith(prefix)));
    },
    get size(): number { return files.size; },
    get bytes(): number { return used; },
  });
}

/** The one statement the simulated interpreter knows. Running a file that holds it prints the lab's canary. */
export const SIM_SCRIPT_STATEMENT = '<?hvwa CANARY ?>';
const STATEMENT = /<\?hvwa[\t\n\r ]+CANARY[\t\n\r ]*\?>/; // linear: no nested or overlapping quantifiers

/**
 * The simulated interpreter: what "running" an uploaded file prints (SC-07, SC-08, SC-09 "the webshell executes").
 * NOTHING EXECUTES (owner decision Q7): no PHP, EJS, Node, eval, vm or child process, ever. The bytes are scanned
 * (as Latin-1, so any binary file works) for the statement `<?hvwa CANARY ?>`, anywhere in the file (a polyglot's
 * tail counts; the whitespace inside it may vary). If it is there, the output is `canary` alone; a function is
 * called only then, so a lab may pass `() => flagFor(req, C)`. If not, null: the script printed nothing. The
 * uploaded bytes are never echoed. WHETHER a file runs is the level's decision (its flawed name or type mapping),
 * made before this is called.
 */
export function simInterpret(bytes: Uint8Array, canary: string | (() => string)): string | null {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!STATEMENT.test(b.toString('latin1'))) return null;
  return typeof canary === 'function' ? canary() : canary;
}
