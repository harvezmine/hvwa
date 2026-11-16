// src/core/sim/world.ts — one player's simulated world at one level: their inbox, their attacker log, the victim's
// recent visits and the clock. All state is per player AND level: every store here must be created inside a
// perSession() factory (they check), as part of the lab's own per-session state, so it is bounded and inherits the
// new-instance limits.
import { capPerSessionHolder, insidePerSessionFactory } from '../lab.js';
import type { Text } from '../registry.js'; // type only: the registry imports the engine side at runtime
import { Browser, type SimBrowser, type SimHandler, type SimVisit } from './browser.js';
import { SIM_LIMITS, clip, str } from './limits.js';

/** The player's own mailbox: the only one the lab page ever shows. */
export const PLAYER_MAILBOX = 'pilgrim@citadel.test';
/** The usual victim's mailbox (labs pass it to simWorld({ mailboxes })). Never shown to the player. */
export const ADMIN_MAILBOX = 'citadel_admin@citadel.test';

/** Sim state is per player and level, and bounded: it caps the holder that keeps it (core/lab.ts). */
function requireSession(what: string): void {
  if (!insidePerSessionFactory()) {
    throw new Error(`${what}: create it inside a perSession() factory (simulated state belongs to one player at one level)`);
  }
  capPerSessionHolder(what, { maxEntries: SIM_LIMITS.worldsPerLab, maxNewPerMinute: SIM_LIMITS.newWorldsPerMinute });
}

// ---------------------------------------------------------------------------------------------------------------
// Inbox

/** One delivered mail. Frozen. */
export interface SimMail {
  /** Increasing per inbox (1, 2, ...). */
  readonly id: number;
  /** Delivery time (ms) from the world's clock. */
  readonly at: number;
  readonly from: string;
  /** The mailbox it was delivered to (normalized address). */
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** The links in the mail, in order ("clicks its first link" is links[0]). Shown as text, never as raw HTML. */
  readonly links: readonly string[];
}

/** A mail to deliver. Non-string fields become ''; long fields are clipped (SIM_LIMITS). */
export interface NewMail {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly links?: readonly string[];
}

/** Mailboxes keyed by address (trimmed, lower case). Only the addresses given at creation exist. */
export interface SimInbox {
  /** The mailboxes, the player's first. */
  readonly addresses: readonly string[];
  /** Deliver a mail; undefined when there is no such mailbox (it bounces, nothing is stored). */
  deliver(mail: NewMail): SimMail | undefined;
  /** A mailbox's mails, newest first ([] for an unknown address). */
  list(address: string): readonly SimMail[];
  /** A mailbox's newest mail. */
  newest(address: string): SimMail | undefined;
  has(address: string): boolean;
}

export interface SimInboxOptions {
  /** Mailboxes besides the player's (PLAYER_MAILBOX always exists), e.g. [ADMIN_MAILBOX]. */
  readonly mailboxes?: readonly string[];
  /** Clock (ms) for delivery times. Default Date.now. */
  readonly now?: () => number;
}

const normalizeAddress = (a: unknown): string => str(a).trim().toLowerCase();
const ADDRESS_RE = /^[^@\s]+@[^@\s]+$/;

/**
 * A per-player inbox (create it inside a perSession factory). A fixed set of mailboxes, so no map is keyed
 * by attacker input: mail to any other address bounces. Each mailbox keeps its newest SIM_LIMITS.mailsPerMailbox.
 */
export function simInbox(opts: SimInboxOptions = {}): SimInbox {
  requireSession('simInbox');
  const now = opts.now ?? Date.now;
  const boxes = new Map<string, SimMail[]>();
  for (const raw of [PLAYER_MAILBOX, ...(opts.mailboxes ?? [])]) {
    const a = normalizeAddress(raw);
    if (a.length > SIM_LIMITS.addressLength || !ADDRESS_RE.test(a)) {
      throw new Error(`simInbox: "${clip(String(raw), 60)}" is not a mail address`);
    }
    if (!boxes.has(a)) boxes.set(a, []);
  }
  if (boxes.size > SIM_LIMITS.mailboxes) throw new Error(`simInbox: at most ${SIM_LIMITS.mailboxes} mailboxes`);
  const addresses = Object.freeze([...boxes.keys()]);
  let nextId = 1;
  return Object.freeze({
    addresses,
    deliver(mail: NewMail): SimMail | undefined {
      const to = normalizeAddress(mail?.to);
      const box = boxes.get(to);
      if (box === undefined) return undefined;
      const links = Array.isArray(mail.links)
        ? mail.links.filter((l): l is string => typeof l === 'string').slice(0, SIM_LIMITS.linksPerMail)
          .map((l) => clip(l, SIM_LIMITS.urlLength + 1)) // one past the cap: an over-long link stays too long to follow
        : [];
      const m: SimMail = Object.freeze({
        id: nextId++, at: now(), from: clip(str(mail.from), SIM_LIMITS.addressLength), to,
        subject: clip(str(mail.subject), SIM_LIMITS.subjectLength), body: clip(str(mail.body), SIM_LIMITS.bodyLength),
        links: Object.freeze(links),
      });
      box.unshift(m);
      if (box.length > SIM_LIMITS.mailsPerMailbox) box.length = SIM_LIMITS.mailsPerMailbox;
      return m;
    },
    list: (address: string): readonly SimMail[] => Object.freeze([...(boxes.get(normalizeAddress(address)) ?? [])]),
    newest: (address: string): SimMail | undefined => boxes.get(normalizeAddress(address))?.[0],
    has: (address: string): boolean => boxes.has(normalizeAddress(address)),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Attacker log

/** One request the player's server (attacker.test) received. Frozen. */
export interface AttackerHit {
  /** 1, 2, 3 ...: never reused, so dropped entries show as a gap. */
  readonly seq: number;
  /** When it arrived (ms), from the world's clock. */
  readonly at: number;
  readonly method: string;
  /** The URL as the server saw it (no userinfo, no fragment). */
  readonly url: string;
  /** The Referer header, when the browser sent one (only ever a citadel URL). */
  readonly referer?: string;
  /** The urlencoded form body of a POST. */
  readonly body?: string;
}

/** What AttackerLog.record() takes. */
export interface AttackerRequest {
  readonly method: string;
  readonly url: string;
  readonly referer?: string;
  readonly body?: string;
}

/** The player's server log: append-only and capped. */
export interface AttackerLog {
  /** Oldest first; the newest SIM_LIMITS.logEntries. */
  entries(): readonly AttackerHit[];
  /** Requests received so far (the newest entry's seq). */
  readonly total: number;
  /** Append a request (SimBrowser does this for every attacker.test request). Fields are clipped. */
  record(hit: AttackerRequest): AttackerHit;
}

/** A per-player attacker log (create it inside a perSession factory). */
export function attackerLog(opts: { readonly now?: () => number } = {}): AttackerLog {
  requireSession('attackerLog');
  const now = opts.now ?? Date.now;
  const list: AttackerHit[] = [];
  let total = 0;
  return Object.freeze({
    entries: (): readonly AttackerHit[] => Object.freeze([...list]),
    get total(): number { return total; },
    record(hit: AttackerRequest): AttackerHit {
      const e: AttackerHit = Object.freeze({
        seq: ++total, at: now(), method: clip(str(hit.method), 10), url: clip(str(hit.url), SIM_LIMITS.urlLength),
        ...(typeof hit.referer === 'string' ? { referer: clip(hit.referer, SIM_LIMITS.urlLength) } : {}),
        ...(typeof hit.body === 'string' ? { body: clip(hit.body, SIM_LIMITS.urlLength) } : {}),
      });
      list.push(e);
      if (list.length > SIM_LIMITS.logEntries) list.shift();
      return e;
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// World: one player's simulation at one level

export type SimWorldOptions = SimInboxOptions;

/** One player's simulated world at one level. Keep it in the lab's perSession state. */
export interface SimWorld {
  readonly inbox: SimInbox;
  readonly attackerLog: AttackerLog;
  /** Clock (ms) for mail dates, log times and cookie expiry: a test seam (`world.now = () => t`). */
  now: () => number;
  /** The victim's recent visits, newest last (at most SIM_LIMITS.visits). Each victim action starts a fresh list. */
  readonly visits: readonly SimVisit[];
  /** The note the last victim action left: bilingual Text, or a string (lab content, English), or ''. */
  readonly note: Text | string;
  /** A victim's browser whose citadel.test is `handler`. Create it in the same factory (the jar is state). */
  browser(handler: SimHandler): SimBrowser;
}

export class World implements SimWorld {
  now: () => number;
  readonly inbox: SimInbox;
  readonly attackerLog: AttackerLog;
  private recent: SimVisit[] = [];
  /** The visits made during the current (or last) victim action, numbered from 1: the newest SIM_LIMITS.visits. */
  private reported: { readonly n: number; readonly visit: SimVisit }[] = [];
  private actionVisits = 0;
  // Set by the victim routes (mountVictim).
  noteText: Text | string = '';
  acted = false;
  /** The last action threw (its error went to the error handler). */
  failed = false;
  inAction = false;
  lastLink = '';

  constructor(opts: SimWorldOptions) {
    requireSession('simWorld');
    this.now = opts.now ?? Date.now;
    const clock = (): number => this.now();
    this.inbox = simInbox({ mailboxes: opts.mailboxes, now: clock });
    this.attackerLog = attackerLog({ now: clock });
  }

  get visits(): readonly SimVisit[] { return Object.freeze([...this.recent]); }
  get note(): Text | string { return this.noteText; }

  browser(handler: SimHandler): SimBrowser {
    requireSession('SimWorld.browser');
    if (typeof handler !== 'function') throw new Error('SimWorld.browser: handler must be a function');
    return new Browser(this, handler);
  }

  recordVisit(v: SimVisit): void {
    this.recent.push(v);
    if (this.recent.length > SIM_LIMITS.visits) this.recent.shift();
    if (!this.inAction) return; // a lab route's own visit is not part of the last action's report
    this.reported.push(Object.freeze({ n: ++this.actionVisits, visit: v }));
    if (this.reported.length > SIM_LIMITS.visits) this.reported.shift();
  }

  /** The last action's visits (stable numbers) and how many earlier ones were dropped. */
  get report(): { readonly visits: readonly { readonly n: number; readonly visit: SimVisit }[]; readonly dropped: number } {
    return { visits: [...this.reported], dropped: this.actionVisits - this.reported.length };
  }

  /**
   * A victim action starts: a fresh report (failed until it returns), and the link the player sent if the action
   * takes one, to pre-fill the field: clipped one past the cap like mail links, so an over-long link stays too long.
   */
  beginAction(link?: string): void {
    this.recent = [];
    this.reported = [];
    this.actionVisits = 0;
    this.noteText = '';
    this.acted = true;
    this.failed = true;
    this.inAction = true;
    if (link !== undefined) this.lastLink = clip(link, SIM_LIMITS.urlLength + 1);
  }
}

/**
 * One player's simulated world at one level: their inbox (the player's mailbox plus `mailboxes`), their attacker
 * log, the victim's recent visits, and the clock. Create it inside the lab's perSession factory, with the
 * victim's browser(s):
 *
 *   const labs = perSession((level): LabState => {
 *     const world = simWorld({ mailboxes: [ADMIN_MAILBOX] });
 *     const state = { world } as LabState;
 *     state.admin = world.browser((r) => citadel(level, state, r));
 *     return state;
 *   });
 */
export function simWorld(opts: SimWorldOptions = {}): SimWorld {
  return new World(opts);
}
