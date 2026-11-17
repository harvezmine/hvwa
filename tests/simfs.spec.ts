// core/simfs.ts: the upload labs' simulated filesystem (one per player and level, bounded, stored copies only, never
// the real disk) and the simulated interpreter (nothing executes: one statement is pattern-matched).
import { Buffer } from 'node:buffer';
import { describe, it, expect, vi } from 'vitest';
import { CAPPED_BUDGET_BYTES, cappedBudgetUsage, perSession, setCappedBudget } from '../src/core/lab.js';
import type { Level } from '../src/core/levels.js';
import { SIM_LIMITS, simWorld } from '../src/core/sim.js';
import {
  SIMFS_LIMITS, SIM_INCLUDE_OUTPUT_CHARS, SIM_SCRIPT_STATEMENT, SimFsError, resolveSimPath, simFs, simInclude, simInterpret, type SimFs, type SimFsOptions,
} from '../src/core/simfs.js';

let n = 0;
/** Build lab state the way labs must: inside a perSession factory (one fresh session per call). */
function inSession<T>(make: () => T, level: Level = 'acolyte'): T {
  return perSession(() => make()).for({ sessionId: `fs-${++n}`, level });
}
const fresh = (opts?: SimFsOptions): SimFs => inSession(() => simFs(opts));
const fullGc = (): (() => void) => {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('globalThis.gc is missing: run the specs with --expose-gc (vitest.config.ts)');
  return gc;
};
const KiB = 1024;
const text = (fs: SimFs, path: string): string | undefined => fs.read(path)?.bytes.toString();

describe('simFs lives in perSession (per player and level), in the shared budget of large lab state', () => {
  it('refuses to be created outside a perSession factory', () => {
    expect(() => simFs()).toThrow(/simFs: create it inside a perSession\(\) factory/);
  });

  it('one file system per session and level', () => {
    const labs = perSession(() => simFs());
    labs.for({ sessionId: 'p1', level: 'acolyte' }).write('/srv/uploads/a.txt', 'mine');
    expect(text(labs.for({ sessionId: 'p1', level: 'acolyte' }), '/srv/uploads/a.txt')).toBe('mine');
    expect(labs.for({ sessionId: 'p2', level: 'acolyte' }).has('/srv/uploads/a.txt')).toBe(false);
    expect(labs.for({ sessionId: 'p1', level: 'templar' }).has('/srv/uploads/a.txt')).toBe(false);
  });

  it('caps its holder like the simulated victim worlds: at most 30 new instances a minute', () => {
    expect(() => perSession(() => simFs(), { maxNewPerMinute: SIM_LIMITS.newWorldsPerMinute + 1 }).for({ sessionId: 's', level: 'acolyte' }))
      .toThrow(/simFs: a perSession holder that keeps it may create at most 30 new instances a minute/);
    expect(perSession(() => simFs(), { maxNewPerMinute: SIM_LIMITS.newWorldsPerMinute }).for({ sessionId: 's', level: 'acolyte' }).size).toBe(0);
  });

  it('shares the process-wide byte budget: at the budget the least recently used instance is reset', () => {
    const prev = setCappedBudget(2 * SIMFS_LIMITS.weight);
    try {
      const labs = perSession(() => simFs());
      const fs = (sessionId: string) => labs.for({ sessionId, level: 'acolyte' });
      fs('a').write('/x', 'a');
      fs('b').write('/x', 'b');
      fs('c').write('/x', 'c'); // two file systems fit: a goes
      expect(labs.size).toBe(2);
      expect(fs('a').has('/x')).toBe(false); // rebuilt fresh, which evicts b in turn
      expect(text(fs('c'), '/x')).toBe('c');
    } finally {
      setCappedBudget(prev);
    }
  });

  it('with the default budget too, every simFs counts its declared weight (and a reset gives it back)', () => {
    const prev = setCappedBudget(undefined);
    try {
      expect(cappedBudgetUsage().budget).toBe(CAPPED_BUDGET_BYTES);
      const before = cappedBudgetUsage();
      const labs = perSession(() => simFs());
      labs.for({ sessionId: 'w', level: 'acolyte' });
      expect(cappedBudgetUsage()).toEqual({ ...before, bytes: before.bytes + SIMFS_LIMITS.weight, instances: before.instances + 1 });
      labs.reset({ sessionId: 'w', level: 'acolyte' });
      expect(cappedBudgetUsage()).toEqual(before);
    } finally {
      setCappedBudget(prev);
    }
  });

  it('labs with a world, a file system, or both share the one budget: never over it, least recently used first', () => {
    const WORLD = SIM_LIMITS.inboxWeight + SIM_LIMITS.attackerLogWeight + SIM_LIMITS.visitsWeight;
    const FS = SIMFS_LIMITS.weight;
    const prev = setCappedBudget(WORLD + FS + 2 * FS); // room for one victim lab with uploads and two upload labs
    try {
      const disposed: string[] = [];
      const holder = <T>(name: string, make: () => T) => perSession((_l, sid) => ({ sid, ...make() }), { dispose: (v) => { disposed.push(`${name}:${v.sid}`); } });
      const both = holder('both', () => ({ world: simWorld(), fs: simFs() })); // SC-05/SC-09 style
      const uploads = holder('uploads', () => ({ fs: simFs() })); // SC-07 style
      both.for({ sessionId: 'v1', level: 'acolyte' });
      uploads.for({ sessionId: 'u1', level: 'acolyte' });
      uploads.for({ sessionId: 'u2', level: 'acolyte' });
      // Exactly full (WORLD + FS + 2 FS): whatever earlier tests left in the budget made room first.
      expect([cappedBudgetUsage().bytes, cappedBudgetUsage().instances, disposed]).toEqual([WORLD + 3 * FS, 3, []]);
      uploads.for({ sessionId: 'u3', level: 'acolyte' }); // no room: the least recently used (the victim lab) goes
      expect(disposed).toEqual(['both:v1']);
      both.for({ sessionId: 'v2', level: 'acolyte' }); // needs WORLD + FS with 3 FS in use: the oldest upload lab (u1) is enough
      expect(disposed).toEqual(['both:v1', 'uploads:u1']);
      expect(cappedBudgetUsage().bytes).toBe(WORLD + 3 * FS); // exactly full, never over
      uploads.for({ sessionId: 'u4', level: 'acolyte' }); // needs FS: u2 (an FS) is the least recently used
      expect(disposed).toEqual(['both:v1', 'uploads:u1', 'uploads:u2']);
    } finally {
      setCappedBudget(prev);
    }
  });

  it('a lab state that holds a file system next to other state caps that holder too', () => {
    const labs = perSession(() => ({ fs: simFs(), canary: 'c' }), { maxNewPerMinute: 31 });
    expect(() => labs.for({ sessionId: 's', level: 'acolyte' })).toThrow(/at most 30 new instances/);
  });
});

describe('resolveSimPath: the simulated OS path rules (the ground truth a level\'s own check is measured against)', () => {
  it('POSIX rules: absolute, . and empty segments dropped, .. pops (never above the root)', () => {
    const cases: Array<[string, string]> = [
      ['/a/b', '/a/b'], ['a/b', '/a/b'], ['/a//b/', '/a/b'], ['/a/./b', '/a/b'], ['/a/b/../c', '/a/c'], ['', '/'], ['/', '/'],
      ['/../../etc/passwd', '/etc/passwd'], ['/srv/app/uploads/restore/../../templates/welcome.txt', '/srv/app/templates/welcome.txt'],
      ['/srv/x/....//y', '/srv/x/..../y'], ['/a/.../b', '/a/.../b'], ['/a/..b/c', '/a/..b/c'],
    ];
    for (const [path, key] of cases) expect(resolveSimPath(path), path).toBe(key);
  });

  it('a backslash is an ordinary character by default, and a separator on a "/\\\\" (Windows-style) file system', () => {
    expect(resolveSimPath('/srv/app/uploads/restore/..\\..\\templates\\welcome.txt')).toBe('/srv/app/uploads/restore/..\\..\\templates\\welcome.txt');
    expect(resolveSimPath('/srv/app/uploads/restore/..\\..\\templates\\welcome.txt', '/\\')).toBe('/srv/app/templates/welcome.txt');
    expect(resolveSimPath('\\vault\\flag.txt', '/\\')).toBe('/vault/flag.txt');
    expect(resolveSimPath('/public/..\\/vault', '/\\')).toBe('/vault');
  });

  it('names are kept as written: case, NUL, trailing dots and spaces, percent sequences (no decoding, no truncation)', () => {
    for (const p of ['/Up/A.PHP', '/up/shell.php\u0000.jpg', '/up/shell.php.', '/up/shell.php ', '/up/ a ', '/up/shell%2ephp', '/up/%2e%2e%2fx']) {
      expect(resolveSimPath(p), JSON.stringify(p)).toBe(p);
    }
  });

  it('one or more .. above the root stay at the root (an odd count too)', () => {
    expect(['/../etc/passwd', '/../../../etc/passwd', '/a/../../etc/passwd', '../etc/passwd'].map((p) => resolveSimPath(p)))
      .toEqual(['/etc/passwd', '/etc/passwd', '/etc/passwd', '/etc/passwd']);
  });

  it('the RESOLVED path is checked too: a relative path that resolves past 512 characters throws, never is cut', () => {
    expect(resolveSimPath('p'.repeat(511))).toBe(`/${'p'.repeat(511)}`);
    expect(() => resolveSimPath('p'.repeat(512))).toThrow(/longer than 512/);
    expect(() => fresh().write('p'.repeat(512), 'x')).toThrow(SimFsError);
  });

  it('a path over 512 characters, or a non-string, is a SimFsError', () => {
    expect(resolveSimPath(`/${'p'.repeat(511)}`)).toHaveLength(512);
    expect(() => resolveSimPath(`/${'p'.repeat(512)}`)).toThrow(SimFsError);
    expect(() => resolveSimPath(`/${'p'.repeat(512)}`)).toThrow(/longer than 512/);
    expect(() => resolveSimPath(42 as never)).toThrow(SimFsError);
    expect(() => resolveSimPath('/a', '\\' as never)).toThrow(/separators/);
  });
});

describe('simFs: files', () => {
  it('write and read: bytes or UTF-8 text, a declared content type (default application/octet-stream), frozen records', () => {
    const fs = fresh();
    const a = fs.write('/srv/uploads/shell.php', Buffer.from('<?hvwa CANARY ?>'), { contentType: 'image/jpeg' });
    expect(a).toEqual({ path: '/srv/uploads/shell.php', bytes: Buffer.from('<?hvwa CANARY ?>'), contentType: 'image/jpeg', pinned: false });
    expect(Object.isFrozen(a)).toBe(true);
    expect(fs.read('/srv/uploads/shell.php')).toBe(a);
    fs.write('/srv/notes.txt', 'é ✓');
    expect(fs.read('/srv/notes.txt')).toMatchObject({ contentType: 'application/octet-stream', bytes: Buffer.from('é ✓', 'utf8') });
    expect(fs.write('/u8', new Uint8Array([1, 2, 3])).bytes).toEqual(Buffer.from([1, 2, 3]));
  });

  it('every path goes through the OS rules: a traversal write overwrites the pinned sentinel (the SC-10 proof)', () => {
    const fs = fresh();
    fs.write('/srv/app/templates/welcome.txt', 'Welcome, pilgrim.', { pinned: true });
    fs.write('/srv/app/uploads/restore/../../templates/welcome.txt', "hvwa('CANARY')");
    expect(text(fs, '/srv/app/templates/welcome.txt')).toBe("hvwa('CANARY')");
    expect(fs.read('/srv/app/templates/welcome.txt')?.pinned).toBe(true); // an overwrite keeps it pinned
    expect(fs.read('/srv/app/uploads/restore/../../templates/welcome.txt')).toBe(fs.read('/srv/app/templates/welcome.txt'));
    expect(fs.size).toBe(1);
  });

  it('separators "/\\\\": backslash traversal lands outside the directory too; by default it is a filename', () => {
    const win = fresh({ separators: '/\\' });
    win.write('/srv/app/uploads/..\\..\\x.txt', 'w');
    expect(win.list().map((f) => f.path)).toEqual(['/srv/x.txt']);
    expect(win.resolve('a\\b')).toBe('/a/b');
    expect(win.separators).toBe('/\\');
    const posix = fresh();
    posix.write('/srv/app/uploads/..\\..\\x.txt', 'p');
    expect(posix.list().map((f) => f.path)).toEqual(['/srv/app/uploads/..\\..\\x.txt']);
    expect(posix.separators).toBe('/');
    expect(() => inSession(() => simFs({ separators: '\\' as never }))).toThrow(/separators/);
  });

  it('the containment check RECIPES section 9 gives a Divine level works for every directory, the root included', () => {
    // Verbatim from docs/RECIPES.md ("A correct (Divine) check uses the same rules").
    const inside = (fs: SimFs, dir: string, name: string): boolean => {
      const base = fs.resolve(dir);
      const key = fs.resolve(`${base}/${name}`);
      return base === '/' ? key !== '/' : key.startsWith(`${base}/`);
    };
    const posix = fresh();
    const win = fresh({ separators: '/\\' });
    const cases: Array<[SimFs, string, string, boolean]> = [
      [posix, '/srv/app/uploads/restore', 'notes/readme.txt', true],
      [posix, '/srv/app/uploads/restore', '../../templates/welcome.txt', false],
      [posix, '/srv/app/uploads/restore', '....//....//templates/welcome.txt', true], // `....` is a name: it stays inside
      [posix, '/srv/app/uploads/restore', '..\\..\\templates\\welcome.txt', true], // POSIX: one odd filename, inside
      [win, '/srv/app/uploads/restore', '..\\..\\templates\\welcome.txt', false],
      [posix, '/srv/app/uploads/restore', '.', false], // the directory itself is not a file in it
      [posix, '/srv/app/uploads/restore', 'x/../../restore-evil/x', false], // a sibling sharing the prefix
      [posix, '/', 'templates/welcome.txt', true], // the root: everything but the root itself is inside
      [posix, '/', '../../etc/passwd', true],
      [posix, '/', '..', false],
      [posix, '/srv/', 'a', true],
    ];
    for (const [fs, dir, name, expected] of cases) expect(inside(fs, dir, name), `${dir} + ${name}`).toBe(expected);
  });

  it('has, delete and list (a directory is a key prefix; list is oldest write first)', () => {
    const fs = fresh();
    fs.write('/srv/uploads/b.txt', 'b');
    fs.write('/srv/uploads/a.txt', 'a');
    fs.write('/srv/uploadsx/c.txt', 'c');
    fs.write('/vault/flag.txt', 'f');
    expect(fs.list('/srv/uploads').map((f) => f.path)).toEqual(['/srv/uploads/b.txt', '/srv/uploads/a.txt']);
    expect(fs.list('/srv/uploads/').map((f) => f.path)).toEqual(['/srv/uploads/b.txt', '/srv/uploads/a.txt']);
    expect(fs.list().map((f) => f.path)).toEqual(['/srv/uploads/b.txt', '/srv/uploads/a.txt', '/srv/uploadsx/c.txt', '/vault/flag.txt']);
    fs.write('/srv/uploads/b.txt', 'b2'); // an overwrite is the newest write
    expect(fs.list('/srv/uploads').map((f) => f.path)).toEqual(['/srv/uploads/a.txt', '/srv/uploads/b.txt']);
    expect(Object.isFrozen(fs.list())).toBe(true);
    expect([fs.has('/vault/flag.txt'), fs.has('/vault'), fs.has('/nope')]).toEqual([true, false, false]);
    expect([fs.delete('/vault/flag.txt'), fs.delete('/vault/flag.txt')]).toEqual([true, false]);
    expect([fs.size, fs.bytes]).toEqual([3, 4]);
  });

  it('a missing file, a directory or an over-long path reads as absent; writing one or the root is a SimFsError', () => {
    const fs = fresh();
    fs.write('/a/b', 'x');
    const long = `/${'p'.repeat(600)}`;
    expect([fs.read('/a'), fs.read('/nope'), fs.read(long), fs.has(long), fs.delete(long), fs.list(long)]).toEqual([undefined, undefined, undefined, false, false, []]);
    expect(() => fs.write(long, 'x')).toThrow(SimFsError);
    expect(() => fs.write('/', 'x')).toThrow(/root/);
    expect(() => fs.write('/../..', 'x')).toThrow(/root/);
    expect(() => fs.write('/a', 42 as never)).toThrow(/bytes or a string/);
  });

  it('stores its own copies: the source changing afterwards changes nothing; tiny files and slices own their memory', () => {
    const fs = fresh();
    const parent = Buffer.alloc(2 * 1024 * KiB, 0x61);
    const src = Buffer.from('original');
    fs.write('/a', src);
    fs.write('/slice', parent.subarray(100, 110));
    fs.write('/tiny', Buffer.from('t')); // Buffer.from of a small value is a slice of Node's 8 KiB pool
    src.fill(0x41);
    parent.fill(0x42);
    expect([text(fs, '/a'), text(fs, '/slice'), text(fs, '/tiny')]).toEqual(['original', 'a'.repeat(10), 't']);
    for (const f of fs.list()) expect([f.bytes.byteOffset, f.bytes.buffer.byteLength], f.path).toEqual([0, f.bytes.length]);
  });
});

describe('simFs: bounds (SIMFS_LIMITS), dropping the oldest unpinned file like the sim drops its oldest mail', () => {
  it('the defaults', () => {
    expect(SIMFS_LIMITS).toEqual({ files: 32, fileBytes: 128 * KiB, totalBytes: 256 * KiB, pathLength: 512, contentTypeLength: 255, weight: 352 * KiB });
    expect(Object.isFrozen(SIMFS_LIMITS)).toBe(true);
  });

  it('a file over fileBytes is refused and nothing changes', () => {
    const fs = fresh();
    fs.write('/a', 'a');
    expect(fs.write('/max', Buffer.alloc(SIMFS_LIMITS.fileBytes)).bytes.length).toBe(SIMFS_LIMITS.fileBytes);
    expect(() => fs.write('/big', Buffer.alloc(SIMFS_LIMITS.fileBytes + 1))).toThrow(/too large/);
    expect(() => fs.write('/big.txt', 'é'.repeat(SIMFS_LIMITS.fileBytes / 2 + 1))).toThrow(/too large/); // UTF-8 bytes, not characters
    expect(fs.list().map((f) => f.path)).toEqual(['/a', '/max']);
  });

  it('an over-size write is refused by its byte length, before any copy is made', () => {
    const fs = fresh();
    const big = Buffer.alloc(SIMFS_LIMITS.fileBytes + 1);
    const text = 'x'.repeat(SIMFS_LIMITS.fileBytes + 1);
    const alloc = vi.spyOn(Buffer, 'allocUnsafeSlow');
    const from = vi.spyOn(Buffer, 'from');
    try {
      expect(() => fs.write('/big', big)).toThrow(/too large/);
      expect(() => fs.write('/big.txt', text)).toThrow(/too large/);
      // (The path itself is copied; the payload never is.)
      expect(alloc.mock.calls.filter(([n]) => n > SIMFS_LIMITS.fileBytes)).toEqual([]);
      expect(from.mock.calls.filter(([x]) => x === text || x === big)).toEqual([]);
    } finally {
      alloc.mockRestore();
      from.mockRestore();
    }
  });

  it('over the file count, the oldest unpinned file goes; pinned files stay', () => {
    const fs = fresh();
    fs.write('/sentinel', 's', { pinned: true });
    for (let i = 0; i < SIMFS_LIMITS.files - 1; i++) fs.write(`/f${i}`, 'x');
    expect(fs.size).toBe(SIMFS_LIMITS.files);
    fs.write('/new', 'n');
    expect(fs.size).toBe(SIMFS_LIMITS.files);
    expect([fs.has('/sentinel'), fs.has('/f0'), fs.has('/f1'), fs.has('/new')]).toEqual([true, false, true, true]);
  });

  it('over the total size, the oldest unpinned files go until the new one fits; an overwrite counts its old size out', () => {
    const fs = fresh();
    const q = SIMFS_LIMITS.fileBytes / 2; // 64 KiB: four fill the 256 KiB total
    fs.write('/pinned', Buffer.alloc(q), { pinned: true });
    fs.write('/a', Buffer.alloc(q));
    fs.write('/b', Buffer.alloc(q));
    fs.write('/c', Buffer.alloc(q));
    expect(fs.bytes).toBe(SIMFS_LIMITS.totalBytes);
    fs.write('/c', Buffer.alloc(q)); // replaces itself: fits, nothing else goes
    expect(fs.list().map((f) => f.path)).toEqual(['/pinned', '/a', '/b', '/c']);
    fs.write('/d', Buffer.alloc(SIMFS_LIMITS.fileBytes)); // needs 128 KiB: a and b go
    expect(fs.list().map((f) => f.path)).toEqual(['/pinned', '/c', '/d']);
    expect(fs.bytes).toBe(SIMFS_LIMITS.totalBytes);
  });

  it('at full capacity, an overwrite keeps the byte count exact: same size, smaller, and larger with an eviction', () => {
    const fs = fresh();
    const q = SIMFS_LIMITS.totalBytes / 4;
    for (const p of ['/a', '/b', '/c', '/d']) fs.write(p, Buffer.alloc(q));
    expect([fs.size, fs.bytes]).toEqual([4, SIMFS_LIMITS.totalBytes]);
    fs.write('/b', Buffer.alloc(q)); // same size: nothing goes
    expect([fs.size, fs.bytes]).toEqual([4, SIMFS_LIMITS.totalBytes]);
    fs.write('/c', Buffer.alloc(10)); // smaller: frees the difference
    expect([fs.size, fs.bytes]).toEqual([4, 3 * q + 10]);
    fs.write('/c', Buffer.alloc(q + 10)); // larger than it was, past the total: the oldest other file (/a) goes
    expect(fs.list().map((f) => f.path)).toEqual(['/d', '/b', '/c']);
    expect([fs.size, fs.bytes]).toEqual([3, 3 * q + 10]);
    expect(fs.has('/a')).toBe(false);
  });

  it('when pinned files leave no room, the write is refused and nothing changes', () => {
    const fs = fresh();
    fs.write('/p1', Buffer.alloc(SIMFS_LIMITS.fileBytes), { pinned: true });
    fs.write('/p2', Buffer.alloc(SIMFS_LIMITS.fileBytes - 10), { pinned: true });
    fs.write('/small', 'x');
    expect(() => fs.write('/more', Buffer.alloc(11))).toThrow(/full/);
    expect(fs.list().map((f) => f.path)).toEqual(['/p1', '/p2', '/small']);
    fs.write('/p2', 'shrunk'); // an overwrite keeps the pin and frees the room
    expect(fs.read('/p2')?.pinned).toBe(true);
    fs.write('/more', Buffer.alloc(11));
    expect(fs.has('/more')).toBe(true);
  });

  it('a content type is clipped to 255 characters; an explicit pinned: false unpins', () => {
    const fs = fresh();
    expect(fs.write('/a', 'x', { contentType: `text/${'x'.repeat(300)}` }).contentType).toHaveLength(255);
    fs.write('/p', 'x', { pinned: true });
    expect(fs.write('/p', 'y', { pinned: false }).pinned).toBe(false);
  });
});

describe('memory: a filled file system is bounded and keeps only its own bytes', () => {
  /** Fill to every cap at once: 32 files, 512-character two-byte paths, 255-character content types, 256 KiB of data. */
  const fill = (fs: SimFs, tag: number): void => {
    for (let i = 0; i < SIMFS_LIMITS.files; i++) {
      const path = `/${tag}-${i}-`.padEnd(SIMFS_LIMITS.pathLength, '✓');
      fs.write(path, Buffer.alloc(SIMFS_LIMITS.totalBytes / SIMFS_LIMITS.files, i), { contentType: `x/${tag}-${i}-`.padEnd(255, 'ś') });
    }
  };

  it('worst case per instance: the 256 KiB of data plus ~1.8 KiB per file of names and bookkeeping (~315 KiB measured)', () => {
    const gc = fullGc();
    const labs = Array.from({ length: 10 }, () => fresh());
    gc(); gc();
    const before = process.memoryUsage();
    labs.forEach((fs, i) => fill(fs, i));
    gc(); gc();
    const after = process.memoryUsage();
    const perInstance = ((after.heapUsed - before.heapUsed) + (after.arrayBuffers - before.arrayBuffers)) / labs.length;
    expect(labs.every((fs) => fs.size === SIMFS_LIMITS.files && fs.bytes === SIMFS_LIMITS.totalBytes)).toBe(true);
    expect(perInstance).toBeGreaterThan(SIMFS_LIMITS.totalBytes);
    expect(perInstance).toBeLessThan(SIMFS_LIMITS.weight); // its weight in the shared budget: ~10% over the measurement
  });

  it('a resolved path is its own copy: a short path cut from a 1 MiB string does not keep that string alive', () => {
    const gc = fullGc();
    gc(); gc();
    const before = process.memoryUsage().heapUsed;
    const keys = ((): string[] => {
      // One segment, sliced from a large flat parent: split and join hand back a slice of the parent itself.
      const parents = Array.from({ length: 40 }, (_, i) => `/${i}-`.padEnd(1024 * KiB, 'q'));
      return parents.map((p) => resolveSimPath(p.slice(0, 400)));
    })();
    gc(); gc();
    // As views: 40 x 1 MiB (two-byte: 2 MiB) pinned. As copies: 40 x ~400 characters.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(4 * 1024 * KiB);
    expect(keys[39]).toBe(`/39-${'q'.repeat(396)}`);
  });

  it('a file written from a slice of a large buffer keeps only the slice', () => {
    const gc = fullGc();
    const labs = Array.from({ length: 40 }, () => fresh());
    gc(); gc();
    const before = process.memoryUsage();
    labs.forEach((fs, i) => { fs.write('/upload', Buffer.alloc(2 * 1024 * KiB, i).subarray(0, KiB)); });
    gc(); gc();
    const after = process.memoryUsage();
    // As views: 40 x 2 MiB = 80 MiB. As copies: 40 KiB plus noise.
    expect((after.heapUsed - before.heapUsed) + (after.arrayBuffers - before.arrayBuffers)).toBeLessThan(4 * 1024 * KiB);
  });
});

describe('simInterpret: the simulated interpreter (nothing executes; one statement is pattern-matched)', () => {
  const canary = 'HVWA{canary}';

  it('the statement prints the canary, wherever it is in the file and however its whitespace is spelled', () => {
    expect(SIM_SCRIPT_STATEMENT).toBe('<?hvwa CANARY ?>');
    for (const body of [SIM_SCRIPT_STATEMENT, '<?hvwa  CANARY?>', '<?hvwa\nCANARY\n?>', '<?hvwa\tCANARY\r\n?>', `<html>${SIM_SCRIPT_STATEMENT}</html>`]) {
      expect(simInterpret(Buffer.from(body), canary), JSON.stringify(body)).toBe(canary);
    }
    // After an image header (a polyglot) or among arbitrary binary bytes: the file is scanned byte for byte.
    expect(simInterpret(Buffer.concat([Buffer.from('GIF89a\x01\x00\x01\x00\xf7', 'latin1'), Buffer.from([0, 0xff, 0x80]), Buffer.from(SIM_SCRIPT_STATEMENT)]), canary)).toBe(canary);
    expect(simInterpret(new Uint8Array(Buffer.from(SIM_SCRIPT_STATEMENT)), canary)).toBe(canary);
  });

  it('nothing else is understood: the output is null (the script printed nothing)', () => {
    const not = ['', 'hello', "<?php echo file_get_contents('/vault/flag.txt'); ?>", '<?hvwa canary ?>', '<?hvwaCANARY ?>', '<? hvwa CANARY ?>',
      '<?hvwa CANARY', '<?hvwa CANARYX ?>', '<?HVWA CANARY ?>', "<script>hvwa('x')</script>", '<%= process.env %>'];
    for (const body of not) expect(simInterpret(Buffer.from(body), canary), JSON.stringify(body)).toBeNull();
  });

  it('the output is the canary alone, once: the uploaded bytes are never echoed', () => {
    const body = Buffer.from(`<b>before</b>${SIM_SCRIPT_STATEMENT}<script>after()</script>${SIM_SCRIPT_STATEMENT}`);
    expect(simInterpret(body, canary)).toBe(canary);
  });

  it('a canary function is called only when the statement is found (so a lab can pass () => flagFor(req, C))', () => {
    let calls = 0;
    const make = () => { calls++; return canary; };
    expect(simInterpret(Buffer.from('no statement here'), make)).toBeNull();
    expect(calls).toBe(0);
    expect(simInterpret(Buffer.from(SIM_SCRIPT_STATEMENT), make)).toBe(canary);
    expect(calls).toBe(1);
  });

  it('the scan is linear: a quarter megabyte of near-misses takes milliseconds', () => {
    const nearMisses = [Buffer.from('<?hvwa '.repeat(40_000)), Buffer.from(`<?hvwa${' '.repeat(SIMFS_LIMITS.fileBytes - 10)}X`), Buffer.from(`<?hvwa CANARY${' '.repeat(SIMFS_LIMITS.fileBytes - 20)}`)];
    for (const body of nearMisses) {
      const t = performance.now();
      expect(simInterpret(body, canary)).toBeNull();
      expect(performance.now() - t).toBeLessThan(200);
    }
  });
});

describe('simInclude: the simulated include (nothing executes; the file is printed, the one statement is replaced)', () => {
  const canary = 'HVWA{canary}';
  const log = 'GET /?page=rules HTTP/1.1" 200 - "-" "<?hvwa CANARY ?>"\n';

  it('prints the file as text and replaces each statement by the canary, whatever its whitespace', () => {
    expect(simInclude(Buffer.from(`before ${SIM_SCRIPT_STATEMENT} after`), canary)).toEqual({ output: `before ${canary} after`, ran: true });
    expect(simInclude(Buffer.from(`a<?hvwa  CANARY?>b<?hvwa\nCANARY\n?>c${SIM_SCRIPT_STATEMENT}`), canary))
      .toEqual({ output: `a${canary}b${canary}c${canary}`, ran: true });
    expect(simInclude(Buffer.from(log), canary).output).toBe(`GET /?page=rules HTTP/1.1" 200 - "-" "${canary}"\n`);
  });

  it('a file without the statement prints as it is and did not run; other <?hvwa ...?> blocks and code stay text', () => {
    const text = "Rules of the Scriptorium <?hvwa canary ?> <?hvwa ECHO ?> <?php system('id'); ?> <%= 1 %> <script>x()</script>";
    expect(simInclude(Buffer.from(text), canary)).toEqual({ output: text, ran: false });
    expect(simInclude(Buffer.alloc(0), canary)).toEqual({ output: '', ran: false });
    expect(simInclude(Buffer.from(`<?hvwa ECHO ?>${SIM_SCRIPT_STATEMENT}`), canary)).toEqual({ output: `<?hvwa ECHO ?>${canary}`, ran: true });
  });

  it('is byte for byte: Latin-1 text, binary, and a Uint8Array that is a view of a bigger buffer', () => {
    expect(simInclude(Buffer.from([0x41, 0xe9, 0x00, 0xff]), canary).output).toBe('Aé\u0000ÿ');
    const big = Buffer.from(`xx${SIM_SCRIPT_STATEMENT}yy`);
    expect(simInclude(new Uint8Array(big.buffer, big.byteOffset + 2, SIM_SCRIPT_STATEMENT.length), canary)).toEqual({ output: canary, ran: true });
  });

  it('a canary function is called once, and only if the statement is there; a canary string is inserted literally', () => {
    let calls = 0;
    const make = () => { calls++; return canary; };
    expect(simInclude(Buffer.from('nothing here'), make).ran).toBe(false);
    expect(calls).toBe(0);
    expect(simInclude(Buffer.from(SIM_SCRIPT_STATEMENT.repeat(5)), make).output).toBe(canary.repeat(5));
    expect(calls).toBe(1);
    expect(simInclude(Buffer.from(SIM_SCRIPT_STATEMENT), "$& $1 $` $'").output).toBe("$& $1 $` $'");
  });

  it('the output is clipped to 16 KiB (the canary too, if it falls past the clip), and only the first fileBytes are scanned', () => {
    expect(SIM_INCLUDE_OUTPUT_CHARS).toBe(16 * 1024);
    const late = simInclude(Buffer.from(`${'x'.repeat(SIM_INCLUDE_OUTPUT_CHARS + 10)}${SIM_SCRIPT_STATEMENT}`), canary);
    expect(late.output).toBe('x'.repeat(SIM_INCLUDE_OUTPUT_CHARS));
    expect(late.ran).toBe(true);
    expect(simInclude(Buffer.from('y'.repeat(SIMFS_LIMITS.fileBytes + 50)), canary).output).toHaveLength(SIM_INCLUDE_OUTPUT_CHARS);
    expect(simInclude(Buffer.from(`${' '.repeat(SIMFS_LIMITS.fileBytes)}${SIM_SCRIPT_STATEMENT}`), canary).ran).toBe(false);
    expect(simInclude(Buffer.from(SIM_SCRIPT_STATEMENT.repeat(100)), 'z'.repeat(1000)).output).toHaveLength(SIM_INCLUDE_OUTPUT_CHARS);
  });

  it('works on a file a simFs holds (a poisoned log), and never changes it', () => {
    const fs = fresh();
    fs.write('/var/log/scriptorium/access.log', log, { pinned: true });
    expect(simInclude(fs.read('/var/log/scriptorium/access.log')?.bytes ?? Buffer.alloc(0), canary).ran).toBe(true);
    expect(text(fs, '/var/log/scriptorium/access.log')).toBe(log);
  });

  it('the scan is linear: a quarter megabyte of near-misses takes milliseconds', () => {
    const nearMisses = [Buffer.from('<?hvwa '.repeat(40_000)), Buffer.from(`<?hvwa${' '.repeat(SIMFS_LIMITS.fileBytes - 10)}X`), Buffer.from(`<?hvwa CANARY${' '.repeat(SIMFS_LIMITS.fileBytes - 20)}`)];
    for (const body of nearMisses) {
      const t = performance.now();
      expect(simInclude(body, canary).ran).toBe(false);
      expect(performance.now() - t).toBeLessThan(200);
    }
  });
});
