// src/districts/archive-api/_shared/api-lab.ts — the plumbing the Archive API labs share (docs/RECIPES.md section 3, "Archive
// API labs"): the pilgrim's API key and who a Bearer key names, JSON answers, the proof's flag field, and the data the
// landing page's views need (endpoint table, key, JSON request console). Plumbing only: whether a request may do
// something, what a body may carry and what proves the flaw stay in each lab's levels/*.ts and model.ts. Not a challenge:
// nothing here is served by View Source.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { field, header, labPath, perSession } from '../../../core/lab.js';
import { flagFor } from '../../../core/mount.js';
import type { Challenge } from '../../../core/registry.js';
import { curlFor, type CurlSpec } from '../../_shared/curl.js';
import type { Result } from '../../_shared/result.js';

export type { Result } from '../../_shared/result.js';

/** Who a Bearer key names. The curator's key is a model seam (`curatorKey` in a lab's model.ts): never shown, never minted here. */
export type Viewer = 'pilgrim';

const KEY_RE = /^ak_pilgrim_[0-9a-f]{32}$/;

// One key per (session, level): a player's own API key at this level, in perSession like every piece of lab state.
const keys = perSession((): { readonly key: string } => ({ key: `ak_pilgrim_${randomBytes(16).toString('hex')}` }));

/** The pilgrim's API key at this session and level: `ak_pilgrim_<32 hex>`, created on first use. The landing page shows it. */
export function apiKeyFor(req: Pick<Request, 'sessionId' | 'level'>): string {
  return keys.for(req).key;
}

const safeEqual = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The caller of an API request: `Authorization: Bearer <key>` naming this (session, level)'s pilgrim key gives
 * 'pilgrim'; anything else (no header, another scheme, a malformed, repeated or another player's key) gives null. A
 * request with no key shaped like one never creates state. Level files may layer a flawed rule on top of this; the
 * truth about the key lives here.
 */
export function viewerOf(req: Pick<Request, 'sessionId' | 'level' | 'headers'>): Viewer | null {
  const auth = header(req, 'authorization');
  const typed = auth === undefined ? undefined : /^Bearer +(\S+)$/i.exec(auth)?.[1];
  if (typed === undefined || !KEY_RE.test(typed)) return null;
  return safeEqual(typed, apiKeyFor(req)) ? 'pilgrim' : null;
}

/** Send a JSON answer: the status and body, never cached. */
export function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).set('Cache-Control', 'no-store').json(body);
}

/** Send a JSON refusal, `{ "error": "<sentence>" }`, with a real status (401, 403, 404, 405, 410, 422 ...). */
export function jsonError(res: Response, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/**
 * The flag member of a proof's JSON answer: `{ flag }` below Divine, `{}` at Divine, which never issues one (and never
 * computes one). Spread it into the body (`{ ...record, ...flagJson(req, C) }`). Call it only for a proving fact, and
 * never inside tryDb.
 */
export function flagJson(req: Pick<Request, 'sessionId' | 'level'>, challenge: Pick<Challenge, 'id' | 'levels'>): { flag?: string } {
  return req.level === 'divine' ? {} : { flag: flagFor(req, challenge) };
}

// --- The landing page's view data ----------------------------------------------------------------------------------

/** One row of the page's endpoint table. */
export interface ApiEndpoint {
  readonly method: string;
  /** The path below the lab, e.g. '/api/vault'. */
  readonly path: string;
  /** Whether it takes `Authorization: Bearer <key>`. */
  readonly auth: 'none' | 'bearer';
  readonly description: string;
  /** A concrete example (path below the lab, with its query). An open GET example becomes a link. */
  readonly example?: string;
}

/** The request the JSON console sends, as typed (clipped; the lab decides what it does). */
export interface ConsoleRequest { readonly method: string; readonly path: string; readonly headers: string; readonly body: string }

/** Methods the console offers. */
export const CONSOLE_METHODS: readonly string[] = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** What the console may carry, so a typed request stays small. */
export const CONSOLE_LIMITS = Object.freeze({ path: 300, headers: 2000, body: 8 * 1024, headerCount: 20 });

/** The console's typed fields, from a posted form (`method`, `path`, `headers`, `body`), clipped. An unknown method is GET. */
export function consoleRequestOf(req: Request): ConsoleRequest {
  const method = field(req, 'method').toUpperCase();
  return {
    method: CONSOLE_METHODS.includes(method) ? method : 'GET',
    path: field(req, 'path').slice(0, CONSOLE_LIMITS.path),
    headers: field(req, 'headers').slice(0, CONSOLE_LIMITS.headers),
    body: field(req, 'body').slice(0, CONSOLE_LIMITS.body),
  };
}

/** The console's `Name: value` lines as header pairs: at most 20, a token name, no control characters; bad lines are skipped. */
export function consoleHeaders(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}):[ \t]*([^\u0000-\u001f\u007f]*)$/.exec(line);
    if (m !== null && out.length < CONSOLE_LIMITS.headerCount) out.push([m[1], m[2].trimEnd()]);
  }
  return out;
}

export interface ApiViewSpec {
  readonly result: Result | null;
  /** The page's curl line; `signIn: false` is set for you (nobody signs in to the Archive's REST labs). */
  readonly curl: Omit<CurlSpec, 'signIn'>;
  readonly endpoints?: readonly ApiEndpoint[];
  /** For a lab with the JSON console: what the player typed, and what the lab answered (shown in a <pre>). */
  readonly console?: { readonly typed: ConsoleRequest; readonly output: string | null };
  /** Lab-specific view data (never a reserved view key). */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * The view data of an Archive API landing page, for views/endpoints, key and console and the curl note: `base`
 * (labPath), `served` (the level), `result`, `apiKey` (apiKeyFor), `endpoints` (with a link only for an open GET
 * example), `curl`, `requestConsole` (or null), then the lab's `extra`.
 */
export function apiView(req: Request, res: Response, spec: ApiViewSpec): Record<string, unknown> {
  const base = labPath(res);
  return {
    base, served: req.level, result: spec.result, apiKey: apiKeyFor(req),
    endpoints: (spec.endpoints ?? []).map((e) => ({
      method: e.method, path: e.path, auth: e.auth, description: e.description, example: e.example ?? '',
      href: e.method === 'GET' && e.auth === 'none' && e.example !== undefined
        ? `${base}${e.example}${e.example.includes('?') ? '&' : '?'}level=${req.level}` : '',
    })),
    curl: curlFor(req, res, { ...spec.curl, signIn: false }),
    requestConsole: spec.console === undefined ? null : { methods: CONSOLE_METHODS, ...spec.console },
    ...spec.extra,
  };
}
