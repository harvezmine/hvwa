// src/core/sim/limits.ts — the simulation's bounds, and the copying clip every stored field goes through.
import { Buffer } from 'node:buffer';

/** Bounds on everything the simulation stores per player and level (all of it is attacker-influenced). */
export const SIM_LIMITS = Object.freeze({
  /** Longest URL the browser follows, before and after WHATWG serialization (percent-encoding can grow it). */
  urlLength: 2048,
  /** Most redirects (301/302/303/307/308 with Location, or a page's Refresh) one visit follows. */
  maxRedirects: 10,
  /** Longest mail address (and From line). */
  addressLength: 254,
  /** Most mailboxes in one inbox, the player's included (a lab needs the player's and the admin's). */
  mailboxes: 3,
  /** Mails kept per mailbox; the oldest is dropped. */
  mailsPerMailbox: 10,
  subjectLength: 200,
  bodyLength: 2000,
  linksPerMail: 3,
  /** Requests kept in the attacker log; the oldest is dropped (sequence numbers keep counting). */
  logEntries: 30,
  /** Cookies in one browser's jar; the oldest is evicted. */
  cookies: 20,
  /** Longest cookie, name plus value (the browsers' 4096). */
  cookieBytes: 4096,
  /** Recent visits kept for the panel. */
  visits: 5,
  /** Longest note a victim action may leave for the panel. */
  noteLength: 500,
  /**
   * Most instances a perSession holder that keeps sim state may keep (a filled world is about a megabyte): its
   * default, and the most it may ask for (capPerSessionHolder in core/lab.ts).
   */
  worldsPerLab: 250,
  /** Most new instances such a holder creates a rolling minute: its default, and the most it may ask for. */
  newWorldsPerMinute: 30,
});

export const str = (x: unknown): string => (typeof x === 'string' ? x : '');
/**
 * The first n UTF-16 code units of s (all of s when shorter), as a NEW string. Never just slice(): V8 may answer a
 * slice with a view into s that keeps the WHOLE parent alive for as long as the clip lives, so a 100 KB field
 * clipped to 2 KB would still hold 100 KB (measured: ~200 KB kept per 2 KB clip of a 200 KB string). A string
 * that is already short may itself be such a view (of a request body, of a Set-Cookie line), so it is copied too.
 * The round trip through the code units' bytes always builds a new string, keeps every code unit (lone surrogates
 * included) and keeps a one-byte string one-byte. tests/sim.spec.ts ("memory") measures it with a full GC.
 */
export const clip = (s: string, n: number): string => Buffer.from(s.length > n ? s.slice(0, n) : s, 'utf16le').toString('utf16le');
