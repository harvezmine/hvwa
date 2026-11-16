// src/core/sim/cookies.ts — a victim's cookie jar for citadel.test (RFC 6265 as browsers apply it; never real
// cookies, never sent to attacker.test).
import { SIM_LIMITS, clip } from './limits.js';
import { CITADEL_HOST, type SimUrl } from './url.js';

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
/** Longest cookie attribute value (Path ...) a browser accepts; a longer one is ignored (RFC 6265bis). */
const ATTRIBUTE_LENGTH = 1024;

function defaultPath(requestPath: string): string {
  if (!requestPath.startsWith('/')) return '/';
  const i = requestPath.lastIndexOf('/');
  return i <= 0 ? '/' : requestPath.slice(0, i);
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) return true;
  return requestPath.startsWith(cookiePath) && (cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/');
}

export class Jar implements SimCookieJar {
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
    if (typeof path !== 'string' || !path.startsWith('/') || path.length > ATTRIBUTE_LENGTH) {
      throw new Error(`SimCookieJar.set: cookie path must start with "/" and be at most ${ATTRIBUTE_LENGTH} chars (got "${clip(String(path), 40)}")`);
    }
    this.put({
      name: clip(name, SIM_LIMITS.cookieBytes), value: clip(value, SIM_LIMITS.cookieBytes), path: clip(path, ATTRIBUTE_LENGTH),
      secure: opts.secure === true, ...(opts.expiresAt === undefined ? {} : { expiresAt: opts.expiresAt }),
    });
  }

  /** Apply one Set-Cookie line from a citadel response to `at`. Malformed or foreign cookies are ignored. */
  store(line: string, at: SimUrl): void {
    const parts = line.split(';');
    const eq = parts[0].indexOf('=');
    if (eq <= 0) return;
    // Copies: a slice of the line would keep the whole line (with every attribute) alive in the jar.
    const name = clip(parts[0].slice(0, eq).trim(), SIM_LIMITS.cookieBytes);
    const value = clip(parts[0].slice(eq + 1).trim(), SIM_LIMITS.cookieBytes);
    if (!Jar.valid(name, value)) return;
    let path: string | undefined;
    let maxAge: number | undefined;
    let expires: number | undefined;
    let secure = false;
    for (const attr of parts.slice(1)) {
      const i = attr.indexOf('=');
      const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase();
      const v = i === -1 ? '' : attr.slice(i + 1).trim();
      if (v.length > ATTRIBUTE_LENGTH) continue; // an over-long attribute is ignored, as browsers do (RFC 6265bis)
      if (key === 'path') path = v.startsWith('/') ? clip(v, ATTRIBUTE_LENGTH) : undefined;
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
export function parseCookieHeader(header: string): Record<string, string> {
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
