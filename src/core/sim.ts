// src/core/sim.ts — the simulated victim for victim-driven labs (reset emails the admin clicks, OAuth redirects,
// session links): two fictional hosts, a per-player inbox, the player's attacker-server log and a tiny browser.
//
// Deterministic, and NO real network: nothing here opens a socket, resolves a name or fetches. citadel.test
// requests are answered IN PROCESS by a handler the lab builds from its own level functions; attacker.test
// requests are appended to the player's log; every other host is unreachable. Labs that TEACH URL-parsing flaws
// do their own (flawed) checks in their level files: classifySimUrl() is the ground truth for where the victim's
// browser actually went.
//
// All state is per player AND level: every store below must be created inside a perSession() factory (they
// check), as part of the lab's own per-session state, so it is bounded and inherits the new-instance limits.
import { insidePerSessionFactory } from './lab.js';
import type { Level } from './levels.js';

/** The lab itself, as the victim's browser sees it: http://citadel.test/<path> is the lab route <labPath>/<path>. */
export const CITADEL_HOST = 'citadel.test';
/** The player's server: attacker.test and every subdomain of it (*.attacker.test), on any port. */
export const ATTACKER_HOST = 'attacker.test';
export const CITADEL_ORIGIN = `http://${CITADEL_HOST}`;
export const ATTACKER_ORIGIN = `http://${ATTACKER_HOST}`;
/** The player's own mailbox: the only one the lab page ever shows. */
export const PLAYER_MAILBOX = 'pilgrim@citadel.test';
/** The usual victim's mailbox (labs pass it to simWorld({ mailboxes })). Never shown to the player. */
export const ADMIN_MAILBOX = 'citadel_admin@citadel.test';
/** The User-Agent the victim's browser sends to the citadel. */
export const SIM_USER_AGENT = 'CitadelBrowser/1.0 (simulated victim)';

/** Bounds on everything the simulation stores per player and level (all of it is attacker-influenced). */
export const SIM_LIMITS = Object.freeze({
  /** Longest URL the browser follows, before and after WHATWG serialization (percent-encoding can grow it). */
  urlLength: 2048,
  /** Most redirects (3xx with Location, or a page's Refresh) one visit follows. */
  maxRedirects: 10,
  /** Longest mail address (and From line). */
  addressLength: 254,
  /** Most mailboxes in one inbox, the player's included. */
  mailboxes: 8,
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
});

function requireSession(what: string): void {
  if (!insidePerSessionFactory()) {
    throw new Error(`${what}: create it inside a perSession() factory (simulated state belongs to one player at one level)`);
  }
}

const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

function isThenable(x: unknown): x is PromiseLike<unknown> {
  return (typeof x === 'object' || typeof x === 'function') && x !== null
    && typeof (x as { then?: unknown }).then === 'function';
}

/** Which simulated site a URL reaches. */
export type SimSite = 'citadel' | 'attacker' | 'other';
/** Why an `other` URL is unreachable. */
export type SimUnreachable = 'invalid' | 'too-long' | 'scheme' | 'ip' | 'port' | 'host';

/** classifySimUrl()'s answer. For `other` the URL fields are '' unless it parsed as http(s). */
export interface SimUrl {
  readonly site: SimSite;
  /** What a server would see: scheme://host[:port]/path?query. Userinfo and the fragment are never sent. */
  readonly url: string;
  /** scheme://host[:port], as WHATWG serializes it. */
  readonly origin: string;
  /** The host the browser connects to: lower case, IDNA-mapped, percent-decoded, one trailing dot removed. */
  readonly host: string;
  /** The path, percent-encoded, dot segments resolved ('/callback'). */
  readonly path: string;
  /** The raw query string with its '?', or ''. */
  readonly search: string;
  /** The parsed query (a fresh copy per call). */
  readonly query: URLSearchParams;
  /** Whether the URL carried userinfo (user[:password]@). It never decides the site and is never sent. */
  readonly userinfo: boolean;
  /** Why an `other` URL is unreachable; undefined for citadel and attacker. */
  readonly reason?: SimUnreachable;
}

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/; // WHATWG always serializes an IPv4 host as four decimal parts

function result(site: SimSite, u: URL | undefined, host: string, reason?: SimUnreachable): SimUrl {
  return Object.freeze({
    site,
    url: u ? `${u.protocol}//${u.host}${u.pathname}${u.search}` : '',
    origin: u ? u.origin : '',
    host,
    path: u ? u.pathname : '',
    search: u ? u.search : '',
    query: new URLSearchParams(u ? u.search : ''),
    userinfo: u ? u.username !== '' || u.password !== '' : false,
    ...(reason === undefined ? {} : { reason }),
  });
}

/**
 * Where a URL takes the simulated victim's browser. Parsing is the WHATWG URL parser (the one browsers use), so
 * tricks resolve exactly as in a browser; no DNS is involved. In order:
 *
 *  1. Not a string, or longer than SIM_LIMITS.urlLength: `other` (`invalid` / `too-long`).
 *  2. `new URL(input, base)` (relative references need `base`, e.g. a Location header): a parse error is
 *     `other`/`invalid`. WHATWG strips surrounding spaces and inner tabs/newlines, treats `\` as `/` in http(s)
 *     URLs (`http://attacker.test\@citadel.test/` is attacker.test; `/\attacker.test` leaves the site), lower-cases
 *     the host, percent-decodes it and maps IDN per UTS #46 (full-width letters and `。` become ASCII; look-alike
 *     letters from other scripts become `xn--` labels, so never a sim host).
 *  3. A scheme other than http: / https: (`javascript:`, `data:`, `file:` ...): `other`/`scheme`.
 *  4. Serialized longer than SIM_LIMITS.urlLength: `other`/`too-long`.
 *  5. One trailing dot is dropped (`ATTACKER.TEST.` is attacker.test). An IPv4 or IPv6 literal (in any WHATWG
 *     spelling: `0x7f.1`, `2130706433`, `[::1]`): `other`/`ip`. Any empty label (`a..b`, `.x`, two trailing
 *     dots): `other`/`host`.
 *  6. Exactly `citadel.test`: `citadel` on the scheme's default port (80 / 443), else `other`/`port`. Its
 *     subdomains are NOT the citadel (`attacker.test.citadel.test` is `other`).
 *  7. `attacker.test` or any `*.attacker.test`, on any port: `attacker` (`citadel.test.attacker.test` too).
 *  8. Anything else (localhost, example.com ...): `other`/`host`.
 *
 * Userinfo never decides the site: `http://citadel.test@attacker.test/` goes to attacker.test, as in every
 * browser; it is dropped from `url` (servers never receive it) and reported as `userinfo: true`.
 */
export function classifySimUrl(input: string, base?: string): SimUrl {
  if (typeof input !== 'string') return result('other', undefined, '', 'invalid');
  if (input.length > SIM_LIMITS.urlLength) return result('other', undefined, '', 'too-long');
  let u: URL;
  try {
    u = base === undefined ? new URL(input) : new URL(input, base);
  } catch {
    return result('other', undefined, '', 'invalid');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return result('other', undefined, '', 'scheme');
  if (`${u.protocol}//${u.host}${u.pathname}${u.search}`.length > SIM_LIMITS.urlLength) {
    return result('other', undefined, '', 'too-long');
  }
  const host = u.hostname.endsWith('.') ? u.hostname.slice(0, -1) : u.hostname;
  if (host.startsWith('[') || IPV4_RE.test(host)) return result('other', u, host, 'ip');
  if (host.split('.').some((label) => label === '')) return result('other', u, host, 'host');
  if (host === CITADEL_HOST) return u.port === '' ? result('citadel', u, host) : result('other', u, host, 'port');
  if (host === ATTACKER_HOST || host.endsWith(`.${ATTACKER_HOST}`)) return result('attacker', u, host);
  return result('other', u, host, 'host');
}

/**
 * A citadel URL as a link into the real lab: `http://citadel.test/<path>?<query>` is `<base>/<path>?<query>`
 * with `level=<level>` set (replacing any level in the query). `base` is labPath(res). Undefined for any URL
 * that is not the citadel, so attacker or `javascript:` links are never turned into hrefs.
 */
export function labHref(u: SimUrl, base: string, level: Level): string | undefined {
  if (u.site !== 'citadel') return undefined;
  const q = new URLSearchParams(u.search);
  q.set('level', level);
  return `${base}${u.path === '/' ? '' : u.path}?${q.toString()}`;
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
// Cookie jar (citadel.test only)

/** One cookie in a victim's jar. */
export interface SimCookie {
  readonly name: string;
  /** As set (still URL-encoded); SimRequest.cookies has it decoded. */
  readonly value: string;
  readonly path: string;
  readonly secure: boolean;
  /** Expiry (ms, world clock); undefined for a session cookie. */
  readonly expiresAt?: number;
}

export interface SimCookieOptions {
  /** Default '/'. */
  readonly path?: string;
  readonly secure?: boolean;
  readonly expiresAt?: number;
}

/**
 * A victim's cookies for citadel.test: the only site that answers, so the only one that can set them. Never real
 * cookies, never sent to attacker.test. Path, Max-Age / Expires (world clock), Secure (https only) and Domain
 * (must be citadel.test) follow RFC 6265 as browsers apply it; HttpOnly and SameSite are accepted and ignored
 * (the victim runs no scripts, and its navigations are top-level).
 */
export interface SimCookieJar {
  /** Set a cookie directly, e.g. the admin is already signed in. Throws on a bad name or an over-size cookie. */
  set(name: string, value: string, opts?: SimCookieOptions): void;
  /** The value of the first live cookie with this name. */
  get(name: string): string | undefined;
  /** Live cookies, oldest first. */
  list(): readonly SimCookie[];
  delete(name: string, path?: string): void;
  clear(): void;
  readonly size: number;
}

const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/;

function defaultPath(requestPath: string): string {
  if (!requestPath.startsWith('/')) return '/';
  const i = requestPath.lastIndexOf('/');
  return i <= 0 ? '/' : requestPath.slice(0, i);
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) return true;
  return requestPath.startsWith(cookiePath) && (cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/');
}

class Jar implements SimCookieJar {
  private readonly cookies: SimCookie[] = []; // creation order
  /** Bumped on every real change: a request repeated with the same jar is a loop. */
  version = 0;

  constructor(private readonly now: () => number) {}

  private purge(): void {
    const t = this.now();
    for (let i = this.cookies.length - 1; i >= 0; i--) {
      const e = this.cookies[i].expiresAt;
      if (e !== undefined && e <= t) { this.cookies.splice(i, 1); this.version++; }
    }
  }

  private put(c: SimCookie): void {
    this.purge();
    const i = this.cookies.findIndex((x) => x.name === c.name && x.path === c.path);
    if (c.expiresAt !== undefined && c.expiresAt <= this.now()) { // an expired cookie deletes
      if (i !== -1) { this.cookies.splice(i, 1); this.version++; }
      return;
    }
    const frozen = Object.freeze({ ...c });
    if (i !== -1) {
      const old = this.cookies[i];
      if (old.value === c.value && old.secure === c.secure && old.expiresAt === c.expiresAt) return;
      this.cookies[i] = frozen; // keeps its place (creation time)
    } else {
      this.cookies.push(frozen);
      if (this.cookies.length > SIM_LIMITS.cookies) this.cookies.shift();
    }
    this.version++;
  }

  private static valid(name: string, value: string): boolean {
    return TOKEN_RE.test(name) && !CONTROL_RE.test(value) && !value.includes(';')
      && name.length + value.length <= SIM_LIMITS.cookieBytes;
  }

  set(name: string, value: string, opts: SimCookieOptions = {}): void {
    if (typeof name !== 'string' || typeof value !== 'string' || !Jar.valid(name, value)) {
      throw new Error(`SimCookieJar.set: bad cookie "${clip(String(name), 40)}"`);
    }
    const path = opts.path ?? '/';
    if (!path.startsWith('/')) throw new Error(`SimCookieJar.set: cookie path must start with "/" (got "${clip(path, 40)}")`);
    this.put({ name, value, path, secure: opts.secure === true, ...(opts.expiresAt === undefined ? {} : { expiresAt: opts.expiresAt }) });
  }

  /** Apply one Set-Cookie line from a citadel response to `at`. Malformed or foreign cookies are ignored. */
  store(line: string, at: SimUrl): void {
    const parts = line.split(';');
    const eq = parts[0].indexOf('=');
    if (eq <= 0) return;
    const name = parts[0].slice(0, eq).trim();
    const value = parts[0].slice(eq + 1).trim();
    if (!Jar.valid(name, value)) return;
    let path: string | undefined;
    let maxAge: number | undefined;
    let expires: number | undefined;
    let secure = false;
    for (const attr of parts.slice(1)) {
      const i = attr.indexOf('=');
      const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase();
      const v = i === -1 ? '' : attr.slice(i + 1).trim();
      if (key === 'path') path = v.startsWith('/') ? v : undefined;
      else if (key === 'max-age') { if (/^-?\d+$/.test(v)) maxAge = Number(v); }
      else if (key === 'expires') { const d = Date.parse(v); if (!Number.isNaN(d)) expires = d; }
      else if (key === 'domain') {
        const d = v.replace(/^\./, '').toLowerCase();
        if (d !== '' && d !== CITADEL_HOST) return; // a cookie for another domain is rejected, as browsers do
      } else if (key === 'secure') secure = true;
    }
    if (secure && !at.url.startsWith('https:')) return; // only a secure origin may set a Secure cookie
    const expiresAt = maxAge !== undefined ? this.now() + maxAge * 1000 : expires;
    this.put({ name, value, path: path ?? defaultPath(at.path), secure, ...(expiresAt === undefined ? {} : { expiresAt }) });
  }

  /** The Cookie header for a citadel request ('' when none): longest paths first, then oldest first. */
  headerFor(target: SimUrl): string {
    this.purge();
    const https = target.url.startsWith('https:');
    return this.cookies
      .filter((c) => pathMatches(c.path, target.path) && (!c.secure || https))
      .map((c, i) => ({ c, i }))
      .sort((a, b) => b.c.path.length - a.c.path.length || a.i - b.i)
      .map(({ c }) => `${c.name}=${c.value}`)
      .join('; ');
  }

  get(name: string): string | undefined {
    this.purge();
    return this.cookies.find((c) => c.name === name)?.value;
  }

  list(): readonly SimCookie[] {
    this.purge();
    return Object.freeze([...this.cookies]);
  }

  delete(name: string, path?: string): void {
    for (let i = this.cookies.length - 1; i >= 0; i--) {
      const c = this.cookies[i];
      if (c.name === name && (path === undefined || c.path === path)) { this.cookies.splice(i, 1); this.version++; }
    }
  }

  clear(): void {
    if (this.cookies.length > 0) this.version++;
    this.cookies.length = 0;
  }

  get size(): number {
    this.purge();
    return this.cookies.length;
  }
}

/** A Cookie header as a null-prototype record (first occurrence wins; values URL-decoded where possible). */
function parseCookieHeader(header: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const pair of header === '' ? [] : header.split('; ')) {
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq);
    if (Object.hasOwn(out, name)) continue;
    const raw = pair.slice(eq + 1);
    try { out[name] = decodeURIComponent(raw); } catch { out[name] = raw; }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Browser

/** What the lab's citadel handler receives: a plain object built by the browser, never an Express request. */
export interface SimRequest {
  readonly method: 'GET' | 'POST';
  /** The absolute URL (no userinfo, no fragment). */
  readonly url: string;
  /** Path on citadel.test ('/callback'): the lab route <labPath>/callback. */
  readonly path: string;
  readonly query: URLSearchParams;
  /** Lower-case names: host, user-agent, and when present referer, cookie, content-type. */
  readonly headers: Readonly<Record<string, string>>;
  /** Cookies sent with the request (decoded; null prototype). */
  readonly cookies: Readonly<Record<string, string>>;
  /** POST form fields (null prototype); {} for a GET. Works with field(). */
  readonly body: Readonly<Record<string, string>>;
}

/** What the citadel handler answers. Header names are case-insensitive. */
export interface SimResponse {
  readonly status: number;
  /**
   * `Location` (followed on a 3xx), `Set-Cookie` (one line or a list), `Refresh` ("0; url=..": the page moves the
   * browser on, sending ITS URL as Referer: the stand-in for a meta refresh or script navigation) and
   * `Referrer-Policy` (what the next hop's Referer may contain). Others are ignored.
   */
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body?: string;
}

/** The lab's citadel.test: built from its own level functions, synchronous, never real HTTP. */
export type SimHandler = (req: SimRequest) => SimResponse;

export type SimOutcome = 'page' | 'attacker' | 'unreachable' | 'too-many-redirects' | 'loop';

/** One request in a visit. Frozen. */
export interface SimHop {
  readonly site: SimSite;
  readonly method: 'GET' | 'POST';
  /** The URL requested (for an unreachable hop: the URL that could not be reached, clipped). */
  readonly url: string;
  /** How the browser got here: the link itself, a 3xx Location, or a page's Refresh. */
  readonly via: 'start' | 'redirect' | 'refresh';
  readonly referer?: string;
  /** The citadel's status (citadel hops only). */
  readonly status?: number;
  /** Why an `other` hop is unreachable. */
  readonly reason?: SimUnreachable;
}

/** The trace of one navigation (for tests and the panel). Frozen. */
export interface SimVisit {
  /**
   * page: ended on a citadel page (see `page`); attacker: reached attacker.test (logged, nothing comes back);
   * unreachable: an `other` URL; too-many-redirects: more than SIM_LIMITS.maxRedirects; loop: the same request
   * again with the jar unchanged.
   */
  readonly outcome: SimOutcome;
  readonly hops: readonly SimHop[];
  /** The citadel page the visit ended on (outcome 'page'). */
  readonly page?: { readonly url: string; readonly status: number; readonly body: string };
}

export interface SimNavigateOptions {
  /**
   * The citadel page the victim clicked the link on: it is the Referer of the first request, and stays the
   * Referer across redirects. Default: none (the link was opened from a mail client). Must be a citadel URL.
   */
  readonly referrer?: string;
}

/** A victim's browser: a cookie jar plus a navigation loop. */
export interface SimBrowser {
  readonly cookies: SimCookieJar;
  /** Open a link (GET). */
  follow(url: string, opts?: SimNavigateOptions): SimVisit;
  /** Submit a form (POST, urlencoded). */
  submit(url: string, form: Readonly<Record<string, string>>, opts?: SimNavigateOptions): SimVisit;
}

type ReferrerPolicy = 'no-referrer' | 'no-referrer-when-downgrade' | 'same-origin' | 'origin' | 'strict-origin'
  | 'origin-when-cross-origin' | 'strict-origin-when-cross-origin' | 'unsafe-url';
const POLICIES: ReadonlySet<string> = new Set([
  'no-referrer', 'no-referrer-when-downgrade', 'same-origin', 'origin', 'strict-origin',
  'origin-when-cross-origin', 'strict-origin-when-cross-origin', 'unsafe-url',
]);
/** The legacy browser default (before 2020): the full URL, except https -> http. Pages tighten it with Referrer-Policy. */
const DEFAULT_POLICY: ReferrerPolicy = 'no-referrer-when-downgrade';

/** A Referrer-Policy header value: the last recognized token, or undefined (unknown tokens are ignored). */
function parsePolicy(values: readonly string[] | undefined): ReferrerPolicy | undefined {
  let found: ReferrerPolicy | undefined;
  for (const token of (values ?? []).join(',').split(',')) {
    const p = token.trim().toLowerCase();
    if (POLICIES.has(p)) found = p as ReferrerPolicy;
  }
  return found;
}

/** The Referer a request from page `from` to `to` carries under `policy` (Referrer Policy spec, without length limits). */
function refererFor(from: SimUrl, to: SimUrl, policy: ReferrerPolicy): string | undefined {
  const full = from.url;
  const origin = `${from.origin}/`;
  const sameOrigin = from.origin === to.origin;
  const downgrade = from.url.startsWith('https:') && to.url.startsWith('http:');
  switch (policy) {
    case 'no-referrer': return undefined;
    case 'no-referrer-when-downgrade': return downgrade ? undefined : full;
    case 'same-origin': return sameOrigin ? full : undefined;
    case 'origin': return origin;
    case 'strict-origin': return downgrade ? undefined : origin;
    case 'origin-when-cross-origin': return sameOrigin ? full : origin;
    case 'strict-origin-when-cross-origin': return sameOrigin ? full : downgrade ? undefined : origin;
    case 'unsafe-url': return full;
  }
}

/** The URL of a Refresh header ("<delay>; url=<url>", ";" or ",", url= optional, quotes optional), else undefined. */
function refreshTarget(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const m = /^\s*\d+(?:\.[\d.]*)?\s*[;,]\s*(?:url\s*=\s*)?(.*)$/is.exec(value);
  if (!m) return undefined;
  let url = m[1].trim();
  const q = url[0];
  if (q === '"' || q === "'") {
    url = url.slice(1);
    const end = url.indexOf(q);
    if (end !== -1) url = url.slice(0, end);
  }
  return url === '' ? undefined : url;
}

/** A handler's response, checked: synchronous, a valid status, a string body. */
function checkResponse(res: unknown): SimResponse {
  if (isThenable(res)) {
    res.then(undefined, () => {}); // never leave its rejection unhandled
    throw new Error('SimHandler must answer synchronously (it returned a Promise)');
  }
  if (res === null || typeof res !== 'object') throw new Error('SimHandler must return { status, headers?, body? }');
  const { status, headers, body } = res as SimResponse;
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error(`SimHandler: bad status ${String(status)}`);
  if (headers !== undefined && (headers === null || typeof headers !== 'object')) throw new Error('SimHandler: headers must be an object');
  if (body !== undefined && typeof body !== 'string') throw new Error('SimHandler: body must be a string');
  return res as SimResponse;
}

/** Response headers by lower-case name; a value or a list of values each. */
function headerMap(res: SimResponse): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
    if (list.length > 0) m.set(k.toLowerCase(), [...(m.get(k.toLowerCase()) ?? []), ...list]);
  }
  return m;
}

/** A form's own string fields, null prototype. */
function formOf(form: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (form === null || typeof form !== 'object') return out;
  for (const [k, v] of Object.entries(form)) if (typeof v === 'string') out[k] = v;
  return out;
}

const encodeForm = (form: Readonly<Record<string, string>>): string => new URLSearchParams(Object.entries(form)).toString();

class Browser implements SimBrowser {
  private readonly jar: Jar;

  constructor(private readonly world: World, private readonly handler: SimHandler) {
    this.jar = new Jar(() => world.now());
  }

  get cookies(): SimCookieJar { return this.jar; }

  follow(url: string, opts: SimNavigateOptions = {}): SimVisit {
    return this.navigate('GET', url, undefined, opts);
  }

  submit(url: string, form: Readonly<Record<string, string>>, opts: SimNavigateOptions = {}): SimVisit {
    return this.navigate('POST', url, formOf(form), opts);
  }

  private navigate(
    startMethod: 'GET' | 'POST', input: string, startBody: Record<string, string> | undefined, opts: SimNavigateOptions,
  ): SimVisit {
    let referrer: SimUrl | undefined;
    if (opts.referrer !== undefined) {
      referrer = classifySimUrl(opts.referrer);
      if (referrer.site !== 'citadel') throw new Error('SimBrowser: a referrer must be a citadel.test page');
    }
    let policy: ReferrerPolicy = DEFAULT_POLICY;
    let method = startMethod;
    let body = startBody;
    let raw = str(input);
    let target = classifySimUrl(input);
    let via: SimHop['via'] = 'start';
    let redirects = 0;
    const hops: SimHop[] = [];
    const seen = new Set<string>();
    const finish = (outcome: SimOutcome, page?: SimVisit['page']): SimVisit => {
      const visit: SimVisit = Object.freeze({ outcome, hops: Object.freeze(hops), ...(page ? { page: Object.freeze(page) } : {}) });
      this.world.recordVisit(visit);
      return visit;
    };
    const hop = (h: SimHop): void => { hops.push(Object.freeze(h)); };
    for (;;) {
      if (target.site === 'other') {
        hop({ site: 'other', method, url: target.url || clip(raw, SIM_LIMITS.urlLength), via, ...(target.reason ? { reason: target.reason } : {}) });
        return finish('unreachable');
      }
      const encoded = body === undefined ? undefined : encodeForm(body);
      const key = `${method} ${target.url}\n${encoded ?? ''}\n${this.jar.version}`;
      if (seen.has(key)) return finish('loop');
      seen.add(key);
      const referer = referrer === undefined ? undefined : refererFor(referrer, target, policy);
      const withReferer: { referer?: string } = referer === undefined ? {} : { referer };
      if (target.site === 'attacker') {
        // The player's server: the request is logged and the visit ends (nothing is served back).
        hop({ site: 'attacker', method, url: target.url, via, ...withReferer });
        this.world.attackerLog.record({
          method, url: target.url, ...withReferer, ...(method === 'POST' && encoded !== undefined ? { body: encoded } : {}),
        });
        return finish('attacker');
      }
      const cookie = this.jar.headerFor(target);
      const headers: Record<string, string> = { host: target.host, 'user-agent': SIM_USER_AGENT, ...withReferer };
      if (cookie !== '') headers.cookie = cookie;
      if (method === 'POST') headers['content-type'] = 'application/x-www-form-urlencoded';
      const req: SimRequest = Object.freeze({
        method, url: target.url, path: target.path, query: new URLSearchParams(target.search),
        headers: Object.freeze(headers), cookies: Object.freeze(parseCookieHeader(cookie)),
        body: Object.freeze(formOf(body ?? {})),
      });
      const res = checkResponse(this.handler(req));
      const h = headerMap(res);
      for (const line of h.get('set-cookie') ?? []) this.jar.store(line, target);
      hop({ site: 'citadel', method, url: target.url, via, ...withReferer, status: res.status });
      const location = res.status >= 300 && res.status < 400 ? h.get('location')?.[0] : undefined;
      const refresh = location === undefined ? refreshTarget(h.get('refresh')?.[0]) : undefined;
      if (location === undefined && refresh === undefined) {
        return finish('page', { url: target.url, status: res.status, body: res.body ?? '' });
      }
      if (redirects >= SIM_LIMITS.maxRedirects) return finish('too-many-redirects');
      redirects++;
      if (location !== undefined) {
        // A redirect is not a page: the referrer stays the page that started the navigation; a Referrer-Policy
        // on the redirect response applies from here on (Fetch). 301/302 turn a POST into a GET, 303 always does.
        policy = parsePolicy(h.get('referrer-policy')) ?? policy;
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        raw = location;
        target = classifySimUrl(location, target.url);
        via = 'redirect';
      } else {
        // A page that moves on by itself: the page is the new referrer, under its own Referrer-Policy.
        referrer = target;
        policy = parsePolicy(h.get('referrer-policy')) ?? DEFAULT_POLICY;
        method = 'GET';
        body = undefined;
        raw = refresh as string;
        target = classifySimUrl(raw, target.url);
        via = 'refresh';
      }
    }
  }
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
  /** The note the last victim action left (lab content), or ''. */
  readonly note: string;
  /** A victim's browser whose citadel.test is `handler`. Create it in the same factory (the jar is state). */
  browser(handler: SimHandler): SimBrowser;
}

class World implements SimWorld {
  now: () => number;
  readonly inbox: SimInbox;
  readonly attackerLog: AttackerLog;
  private recent: SimVisit[] = [];
  /** Set by the victim routes (mountVictim). */
  noteText = '';
  acted = false;
  lastLink = '';

  constructor(opts: SimWorldOptions) {
    requireSession('simWorld');
    this.now = opts.now ?? Date.now;
    const clock = (): number => this.now();
    this.inbox = simInbox({ mailboxes: opts.mailboxes, now: clock });
    this.attackerLog = attackerLog({ now: clock });
  }

  get visits(): readonly SimVisit[] { return Object.freeze([...this.recent]); }
  get note(): string { return this.noteText; }

  browser(handler: SimHandler): SimBrowser {
    requireSession('SimWorld.browser');
    if (typeof handler !== 'function') throw new Error('SimWorld.browser: handler must be a function');
    return new Browser(this, handler);
  }

  recordVisit(v: SimVisit): void {
    this.recent.push(v);
    if (this.recent.length > SIM_LIMITS.visits) this.recent.shift();
  }

  /** A victim action starts: a fresh report, and the link the player sent (to pre-fill the field). */
  beginAction(link: string): void {
    this.recent = [];
    this.noteText = '';
    this.acted = true;
    this.lastLink = clip(link, SIM_LIMITS.urlLength);
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
