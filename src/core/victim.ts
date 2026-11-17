// src/core/victim.ts — the engine side of a simulated victim (core/sim/): `defineChallenge({ victim })`'s config and
// its validation, the action presets, the inbox / attacker-log panel under every lab page, the
// `POST <lab>/victim/<name>` routes, sendSimRedirect for real routes that get a sim URL back, and the XSS sink
// interpreter (xssBrowser: the admin's browser "runs" the pages it renders through the static oracle, core/xss/).
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response, Router } from 'express';
import { DEFAULT_LANG, isLang, t, type Lang } from './i18n.js';
import { capPerSessionHolder, field, insidePerSessionFactory, labPath } from './lab.js';
import type { Text } from './registry.js'; // type only: the registry imports this module at runtime
import { sendPage } from './render.js';
import {
  ATTACKER_PAGE_URL, REDIRECT_STATUSES, isThenable, type SimAttackerPage, type SimBrowser, type SimClick, type SimClickOptions,
  type SimCrossSiteOptions, type SimCrossSitePostOptions, type SimFetch, type SimFetchOptions, type SimFetchVerdict, type SimFrame,
  type SimFrameOptions,
  type SimHandler, type SimNavigateOptions, type SimOutcome, type SimRequest, type SimResponse, type SimVisit,
} from './sim/browser.js';
import type { SimCookieJar } from './sim/cookies.js';
import { formEntries, framingOf, type SimFormFields } from './sim/cross.js';
import { SIM_LIMITS, clip, str } from './sim/limits.js';
import { ATTACKER_ORIGIN, CITADEL_ORIGIN, classifySimUrl, labHref, type SimUnreachable, type SimUrl } from './sim/url.js';
import { PLAYER_MAILBOX, World, type SimWorld } from './sim/world.js';
import { XSS_LIMITS } from './xss/limits.js';
import { markerCall, markerNonce } from './xss/marker.js';
import { xssOracle, type XssInsertion, type XssOracleOptions, type XssVerdict } from './xss/oracle.js';
import { DOCUMENT_MIME_TYPES } from './xss/rules.js';

/**
 * One button under the lab. `POST <lab>/victim/<name>?level=<level>` runs `run` synchronously (the scripted
 * victim), then answers 303 back to the lab page, so it works without JavaScript.
 */
export interface VictimAction {
  /** kebab-case a-z0-9: the route is POST <lab>/victim/<name>. */
  readonly name: string;
  /** The button text. VICTIM_LABELS has the two usual ones. */
  readonly label: Text;
  /**
   * What the scripted victim does, shown under the button (player guidance, so bilingual), e.g. "opens the newest
   * mail and clicks its first link" or "opens any link you send, while signed in to Pilgrim-ID".
   */
  readonly description?: Text;
  /** 'url': the form has a link field; run gets it as `input.url` ('' when missing or not a string). */
  readonly input?: 'url';
  /**
   * The scripted victim, e.g. "the admin opens the newest mail and clicks its first link". Synchronous; works on
   * the lab's own per-session state for this request (req.sessionId, req.level). May return a short note for the
   * panel: feedback the visit summary cannot show (e.g. "the admin was not signed in"), as bilingual Text (shown
   * in the player's language) or a string (lab content, English). Each is clipped to SIM_LIMITS.noteLength.
   */
  readonly run: (req: Request, input: { readonly url: string }) => Text | string | void;
}

/** A challenge's simulated victim: `defineChallenge({ victim })`. The engine mounts the actions and the panel. */
export interface VictimConfig {
  /** This request's world: the simWorld() kept in the lab's perSession state. */
  readonly sim: (req: Pick<Request, 'sessionId' | 'level'>) => SimWorld;
  readonly actions: readonly VictimAction[];
}

const textOf = (key: string, vars: Readonly<Record<string, string | number>> = {}): Text =>
  Object.freeze({ id: fmt(t(key, 'id'), vars), en: fmt(t(key, 'en'), vars) });

/** Platform labels (ID/EN) for the two usual actions. */
export const VICTIM_LABELS = Object.freeze({
  /** "Ask the admin to check mail" */
  checkMail: textOf('sim.action.check_mail'),
  /** "Send link to the admin" (use with input: 'url') */
  sendLink: textOf('sim.action.send_link'),
  /** "Ask the admin to open your page" (visitAttackerPageAction) */
  visitPage: textOf('sim.action.visit_page'),
  /** "Send the admin a link to your page" (sendAttackerPageAction) */
  sendPage: textOf('sim.action.send_page'),
  /** "Ask the admin to open your framing page" (frameAndClickAction) */
  frameAndClick: textOf('sim.action.frame_click'),
});

/** A preset's re-arm step (see VictimPresetOptions.rearm). */
export type VictimRearm = (req: Request, browser: SimBrowser) => void;

/** What every action preset takes besides its own options. */
export interface VictimPresetOptions {
  /** The route name, kebab-case (default 'check-mail' / 'send-link'). */
  readonly name?: string;
  /** The button (default VICTIM_LABELS.checkMail / .sendLink). */
  readonly label?: Text;
  /** What the victim does, under the button (a platform default fits the preset). */
  readonly description?: Text;
  /**
   * REQUIRED. Runs at the start of EVERY action, before the victim browses: restore the victim's standing state,
   * which the player's last link may have undone (a link to /logout, or a page whose cookies overflow the jar and
   * evict the admin's session). Sign in by setting the cookie (`browser.cookies.set`), as the lab's factory does;
   * never browse here (that visit would show in the report). Without it a lab with no Restart can stay stuck until
   * the 26 h TTL. A victim with no standing state passes an explicit no-op (`rearm: () => {}`): the choice is made
   * on purpose, never by omission.
   */
  readonly rearm: VictimRearm;
}

/** checkMailAction()'s options. */
export interface CheckMailOptions extends VictimPresetOptions {
  /** The victim's browser for this request, e.g. `(req) => labFor(req).admin`. Its world's inbox is read. */
  readonly browser: (req: Request) => SimBrowser;
  /** The mailbox the victim reads, e.g. ADMIN_MAILBOX (one of its world's). */
  readonly mailbox: string;
  /** Which link of the newest mail the victim clicks: 0 (the default) is the first. */
  readonly link?: number;
}

function checkPreset(what: string, browser: unknown, opts: VictimPresetOptions | undefined): void {
  if (typeof browser !== 'function') throw new Error(`${what}: browser must be a function (req) => SimBrowser`);
  const rearm: unknown = opts?.rearm;
  if (rearm === undefined) {
    throw new Error(`${what}: rearm is required (restore the victim's standing state, or pass () => {} if it has none)`);
  }
  if (typeof rearm !== 'function') throw new Error(`${what}: rearm must be a function (req, browser) => void`);
}

/**
 * "Ask the admin to check mail": the victim opens the newest mail in `mailbox` and clicks its link number `link`
 * (from a mail client: no Referer). A bilingual note says when there is no mail or no such link.
 */
export function checkMailAction(opts: CheckMailOptions): VictimAction {
  const { browser, mailbox, link = 0, rearm } = opts;
  checkPreset('checkMailAction', browser, opts);
  if (typeof mailbox !== 'string') throw new Error('checkMailAction: mailbox must be a mail address');
  if (!Number.isInteger(link) || link < 0 || link >= SIM_LIMITS.linksPerMail) {
    throw new Error(`checkMailAction: link must be an integer from 0 to ${SIM_LIMITS.linksPerMail - 1} (got ${String(link)})`);
  }
  const n = link + 1;
  return Object.freeze({
    name: opts.name ?? 'check-mail',
    label: opts.label ?? VICTIM_LABELS.checkMail,
    description: opts.description ?? (link === 0 ? textOf('sim.describe.check_mail') : textOf('sim.describe.check_mail_link', { n })),
    run: (req: Request): Text | void => {
      const b = browser(req);
      rearm(req, b);
      if (!b.world.inbox.has(mailbox)) throw new Error(`checkMailAction: the world has no mailbox "${clip(mailbox, 60)}"`);
      const mail = b.world.inbox.newest(mailbox);
      if (mail === undefined) return textOf('sim.note.mailbox_empty');
      const url = mail.links[link];
      if (url === undefined) return textOf('sim.note.no_link', { n });
      b.follow(url);
    },
  });
}

/** "Send link to the admin": the victim opens whatever link the player sends (the form's link field). */
export function sendLinkAction(browser: (req: Request) => SimBrowser, opts: VictimPresetOptions): VictimAction {
  checkPreset('sendLinkAction', browser, opts);
  const { rearm } = opts;
  return Object.freeze({
    name: opts.name ?? 'send-link',
    label: opts.label ?? VICTIM_LABELS.sendLink,
    description: opts.description ?? textOf('sim.describe.send_link'),
    input: 'url',
    run: (req: Request, { url }: { readonly url: string }): void => {
      const b = browser(req);
      rearm(req, b);
      b.follow(url);
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Across sites (engine task E1): the admin opens the player's attacker page, which submits a form, follows a link,
// calls fetch() or frames a citadel page. The page is the player's input, declared by the lab (never parsed from
// HTML, never run): what it does is one AttackerStep, and the browser rules (core/sim/cross.ts, the SameSite jar)
// decide what reaches the citadel and what comes back.

/** Where a page that read a cross-origin answer sends it: `POST <ATTACKER_EXFIL_URL>`, the answer as the body. */
export const ATTACKER_EXFIL_URL = `${ATTACKER_ORIGIN}/exfil`;

/** The one thing the player's attacker page does when the admin opens it. */
export type AttackerStep =
  /**
   * An auto-submitting `<form action method enctype>` of hidden fields: a top-level navigation (CSRF). POST (the
   * default) runs crossSitePost; GET puts the fields in the action's query and runs crossSiteLink.
   */
  | { readonly kind: 'form'; readonly action: string; readonly method?: 'GET' | 'POST'; readonly enctype?: string; readonly fields: SimFormFields }
  /** `location = url`, or a link the admin clicks: a top-level GET navigation (crossSiteLink). */
  | { readonly kind: 'link'; readonly url: string }
  /**
   * `fetch(url, init)` (corsFetch). When the browser lets the page read the answer, the page sends it home:
   * `POST ATTACKER_EXFIL_URL` with the answer as its body lands in the player's attacker log (FP-03's proof).
   */
  | ({ readonly kind: 'fetch'; readonly url: string } & Omit<SimFetchOptions, 'page'>);

/** The player's attacker page as the lab stores it: where it is (its URL, policy, sandbox) and what it does. */
export interface AttackerScript {
  /** Default: http://attacker.test/ with Chrome's default policy. sendAttackerPageAction puts it at the link sent. */
  readonly page?: SimAttackerPage;
  readonly does: AttackerStep;
}

/** What visitAttackerPageAction and sendAttackerPageAction take besides the usual preset options. */
export interface AttackerPageOptions extends VictimPresetOptions {
  /** The victim's browser for this request, e.g. `(req) => labFor(req).admin`. */
  readonly browser: (req: Request) => SimBrowser;
  /** The player's attacker page for this request, as the lab keeps it in its per-session state; undefined: none yet. */
  readonly page: (req: Request) => AttackerScript | undefined;
}

/** The page shown in the player's frame, as frameAndClickAction's `click` sees it (SimFrame.page). */
export type FramedPage = NonNullable<SimFrame['page']>;

/** The form a framed page's button submits (the lab's own page knows its forms; the sim reads no HTML). */
export interface FramedForm {
  /** The form's action, absolute or relative to the framed page. */
  readonly action: string;
  readonly fields: SimFormFields;
  /** The form's enctype (default urlencoded). */
  readonly enctype?: string;
}

/** frameAndClickAction()'s options. */
export interface FrameAndClickOptions extends VictimPresetOptions {
  readonly browser: (req: Request) => SimBrowser;
  /**
   * What the admin's click submits on the page your frame shows, under your decoy: that page's form (the lab says
   * which, from the page's URL and its own state), or undefined when the page has no such button.
   */
  readonly click: (req: Request, framed: FramedPage) => FramedForm | undefined;
  /** The framing page (default http://attacker.test/), e.g. a lab field for its URL. */
  readonly page?: (req: Request) => Omit<SimAttackerPage, 'sandboxed'> | undefined;
}

/**
 * The step kinds the presets run, keyed by kind so a new AttackerStep member (AR-14's `{ kind: 'websocket', url }`,
 * Phase 3) cannot compile without its entry here and its case in runAttackerPage. Until then a websocket step is a lab
 * bug, refused like any unknown kind.
 */
const STEP_KINDS: Readonly<Record<AttackerStep['kind'], true>> = Object.freeze({ form: true, link: true, fetch: true });

/** A lab's AttackerScript, checked: a programming error throws (the player's strings are data, never checked here). */
function checkScript(s: unknown): AttackerScript {
  const does = (s as AttackerScript | null)?.does as Partial<Record<string, unknown>> | undefined;
  if (s === null || typeof s !== 'object' || does === null || typeof does !== 'object' || !Object.hasOwn(STEP_KINDS, String(does.kind))) {
    throw new Error(`attacker page: page(req) must return { page?, does: { kind: ${Object.keys(STEP_KINDS).map((k) => `'${k}'`).join(' | ')}, ... } } or undefined`);
  }
  const url = does.kind === 'form' ? does.action : does.url;
  if (typeof url !== 'string') throw new Error(`attacker page: a ${String(does.kind)} step needs a string ${does.kind === 'form' ? 'action' : 'url'}`);
  return s as AttackerScript;
}

/** A GET form's URL: the action with its query replaced by the fields (HTML), or the action as given when it does not parse. */
function getFormUrl(action: string, fields: SimFormFields, base: string): string {
  try {
    const u = new URL(action, base);
    u.search = new URLSearchParams(formEntries(fields)).toString();
    return u.href;
  } catch {
    return action;
  }
}

/** The note for a fetch the page made: what its devtools console would say. */
const FETCH_NOTES: Readonly<Record<SimFetchVerdict, string>> = Object.freeze({
  readable: 'sim.note.fetch_read', preflight: 'sim.note.fetch_preflight', invalid: 'sim.note.fetch_invalid',
  'no-answer': 'sim.note.fetch_no_answer', 'no-allow-origin': 'sim.note.cors_no_allow_origin',
  'origin-mismatch': 'sim.note.cors_origin_mismatch', 'wildcard-credentials': 'sim.note.cors_wildcard_credentials',
  'no-allow-credentials': 'sim.note.cors_no_allow_credentials',
});

/**
 * The admin opens the attacker page at `page` (your server logs that GET, as for any link), then the page does its
 * one step. A fetch the browser lets the page read is sent home (ATTACKER_EXFIL_URL). Returns the note for the panel.
 */
function runAttackerPage(b: SimBrowser, script: AttackerScript, page: SimAttackerPage): Text | void {
  const at = classifySimUrl(str(page.url ?? ATTACKER_PAGE_URL));
  if (at.site !== 'attacker') return textOf('sim.note.not_your_server');
  b.follow(at.url);
  const { does } = script;
  const opts = { page };
  switch (does.kind) {
    case 'link':
      b.crossSiteLink(does.url, opts);
      return;
    case 'form':
      if (does.method === 'GET') b.crossSiteLink(getFormUrl(does.action, does.fields, at.url), opts);
      else b.crossSitePost(does.action, does.fields, { ...opts, ...(does.enctype === undefined ? {} : { contentType: does.enctype }) });
      return;
    case 'fetch': {
      const { kind: _kind, url, ...init } = does;
      const f = b.corsFetch(url, { ...init, page });
      if (f.verdict === 'readable') b.world.attackerLog.record({ method: 'POST', url: ATTACKER_EXFIL_URL, body: f.body ?? '' });
      return textOf(FETCH_NOTES[f.verdict]);
    }
    default: { // every kind is handled above: a new AttackerStep member (AR-14's websocket) fails to compile here
      const unhandled: never = does;
      throw new Error(`attacker page: no step ${JSON.stringify((unhandled as { kind?: unknown }).kind)}`);
    }
  }
}

function checkFunction(what: string, name: string, fn: unknown): void {
  if (typeof fn !== 'function') throw new Error(`${what}: ${name} must be a function`);
}

/**
 * "Ask the admin to open your page": the admin, signed in to the citadel, opens the player's attacker page (where
 * `page(req)` says it is, default http://attacker.test/), and the page does its step: an auto-submitted form or a
 * link (CSRF: FP-01, FP-02), or a fetch whose readable answer it sends home (CORS: FP-03). A bilingual note says
 * when there is no page yet, and what the browser said about a fetch.
 */
export function visitAttackerPageAction(opts: AttackerPageOptions): VictimAction {
  const { browser, page, rearm } = opts;
  checkPreset('visitAttackerPageAction', browser, opts);
  checkFunction('visitAttackerPageAction', 'page', page);
  return Object.freeze({
    name: opts.name ?? 'visit-attacker-page',
    label: opts.label ?? VICTIM_LABELS.visitPage,
    description: opts.description ?? textOf('sim.describe.visit_page'),
    run: (req: Request): Text | void => {
      const b = browser(req);
      rearm(req, b);
      const raw: unknown = page(req);
      if (raw === undefined) return textOf('sim.note.no_page');
      const script = checkScript(raw);
      return runAttackerPage(b, script, script.page ?? {});
    },
  });
}

/**
 * "Send the admin a link to your page": as visitAttackerPageAction, but the page is at the link the player sends (its
 * origin and path are the player's choice: `http://citadel.test.attacker.test/`, `http://attacker.test/citadel?x`).
 * A link off attacker.test is not opened (a note says so): this preset never sends the admin anywhere else.
 */
export function sendAttackerPageAction(opts: AttackerPageOptions): VictimAction {
  const { browser, page, rearm } = opts;
  checkPreset('sendAttackerPageAction', browser, opts);
  checkFunction('sendAttackerPageAction', 'page', page);
  return Object.freeze({
    name: opts.name ?? 'send-attacker-page',
    label: opts.label ?? VICTIM_LABELS.sendPage,
    description: opts.description ?? textOf('sim.describe.send_page'),
    input: 'url',
    run: (req: Request, { url }: { readonly url: string }): Text | void => {
      const b = browser(req);
      rearm(req, b);
      if (classifySimUrl(url).site !== 'attacker') return textOf('sim.note.not_your_server');
      const raw: unknown = page(req);
      if (raw === undefined) return textOf('sim.note.no_page');
      const script = checkScript(raw);
      return runAttackerPage(b, script, { ...script.page, url });
    },
  });
}

/**
 * "Ask the admin to open your framing page" (clickjacking, FP-04): the admin opens your page, which frames the
 * citadel link you send; if the browser shows it there (no X-Frame-Options or frame-ancestors refusal), the admin
 * clicks your decoy, which lies over the framed page's button: `click(req, framed)` names that page's form, and it is
 * submitted inside the frame (clickThrough). Notes say why the frame stayed empty or the click did nothing.
 */
export function frameAndClickAction(opts: FrameAndClickOptions): VictimAction {
  const { browser, click, rearm } = opts;
  checkPreset('frameAndClickAction', browser, opts);
  checkFunction('frameAndClickAction', 'click', click);
  if (opts.page !== undefined) checkFunction('frameAndClickAction', 'page', opts.page);
  return Object.freeze({
    name: opts.name ?? 'frame-and-click',
    label: opts.label ?? VICTIM_LABELS.frameAndClick,
    description: opts.description ?? textOf('sim.describe.frame_click'),
    input: 'url',
    run: (req: Request, { url }: { readonly url: string }): Text | void => {
      const b = browser(req);
      rearm(req, b);
      const page = opts.page?.(req) ?? {};
      const at = classifySimUrl(str(page.url ?? ATTACKER_PAGE_URL));
      if (at.site !== 'attacker') return textOf('sim.note.not_your_server');
      b.follow(at.url);
      const frame = b.frame(url, { page });
      if (!frame.framed || frame.page === undefined) {
        return textOf(frame.reason === 'x-frame-options' ? 'sim.note.frame_x_frame_options'
          : frame.reason === 'frame-ancestors' ? 'sim.note.frame_frame_ancestors' : 'sim.note.frame_not_loaded');
      }
      const target: unknown = click(req, frame.page);
      if (target === undefined) return textOf('sim.note.nothing_to_click');
      const t = target as Partial<FramedForm> | null;
      if (t === null || typeof t !== 'object' || typeof t.action !== 'string' || t.fields === null || typeof t.fields !== 'object') {
        throw new Error('frameAndClickAction: click(req, framed) must return { action, fields, enctype? } or undefined');
      }
      b.clickThrough(frame, t.action, t.fields, t.enctype === undefined ? {} : { contentType: t.enctype });
    },
  });
}

const ACTION_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isText(x: unknown): x is Text {
  return x !== null && typeof x === 'object' && typeof (x as Text).id === 'string' && typeof (x as Text).en === 'string';
}

/** Validate `defineChallenge({ victim })` (the registry calls it). Throws a message naming the problem. */
export function assertVictimConfig(v: unknown, at: string): asserts v is VictimConfig {
  if (v === null || typeof v !== 'object') throw new Error(`${at}: victim must be an object`);
  const { sim, actions } = v as { sim?: unknown; actions?: unknown };
  if (typeof sim !== 'function') throw new Error(`${at}: victim.sim must be a function`);
  if (!Array.isArray(actions) || actions.length === 0) throw new Error(`${at}: victim needs at least one action`);
  const names = new Set<string>();
  for (const a of actions as unknown[]) {
    if (a === null || typeof a !== 'object') throw new Error(`${at}: a victim action must be an object`);
    const { name, label, description, input, run } = a as Record<string, unknown>;
    if (typeof name !== 'string' || !ACTION_NAME_RE.test(name)) {
      throw new Error(`${at}: victim action name "${clip(String(name), 40)}" must be kebab-case a-z0-9`);
    }
    if (names.has(name)) throw new Error(`${at}: duplicate victim action "${name}"`);
    names.add(name);
    if (!isText(label)) throw new Error(`${at}: victim action "${name}" needs a label { id, en }`);
    if (description !== undefined && !isText(description)) {
      throw new Error(`${at}: victim action "${name}": description must be bilingual text { id, en }`);
    }
    if (input !== undefined && input !== 'url') throw new Error(`${at}: victim action "${name}": input must be 'url' or absent`);
    if (typeof run !== 'function') throw new Error(`${at}: victim action "${name}": run must be a function`);
  }
}

/**
 * The panel's view model, in the request's language. Nothing is escaped here: the partial
 * (core/views/sim-panel.ejs) outputs every value with the escaped tag. It never shows the victim's own requests
 * (their URLs can carry the very secret the lab is about) nor any mailbox but the player's.
 */
export interface SimPanel {
  readonly hosts: string;
  readonly actions: readonly {
    readonly name: string; readonly action: string; readonly label: string; readonly input: boolean;
    /** What the scripted victim does (the action's description), in the request's language. */
    readonly description?: string;
  }[];
  /** The link the player last sent (pre-fills the link field). */
  readonly lastLink: string;
  /**
   * After a victim action: its note, whether it failed (threw), how many of its earlier visits are not shown, and
   * one summary line per visit, numbered stably (outcome and request count, never URLs).
   */
  readonly report?: { readonly note: string; readonly failed?: string; readonly dropped?: string; readonly visits: readonly string[] };
  readonly mailboxHeading: string;
  readonly mails: readonly {
    readonly from: string; readonly subject: string; readonly at: string; readonly body: string;
    /** href only for citadel links (into the real lab, see labHref); everything else is text. */
    readonly links: readonly { readonly text: string; readonly href?: string }[];
  }[];
  /** The attacker log, newest first. */
  readonly hits: readonly {
    readonly seq: number; readonly at: string; readonly method: string; readonly url: string;
    readonly referer?: string; readonly body?: string;
  }[];
}

function fmt(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
}

function iso(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function worldOf(v: VictimConfig, req: Pick<Request, 'sessionId' | 'level'>): World {
  const w = v.sim(req);
  if (!(w instanceof World)) throw new Error('victim.sim must return the lab\'s simWorld()');
  return w;
}

// The panel's words for each outcome and reason (core/i18n.ts). Typed maps: a new outcome or reason cannot go
// without a string, and no key is built from data.
const OUTCOME_KEYS: Readonly<Record<SimOutcome, string>> = Object.freeze({
  page: 'sim.outcome.page', attacker: 'sim.outcome.attacker', unreachable: 'sim.outcome.unreachable',
  'too-many-redirects': 'sim.outcome.too_many_redirects', loop: 'sim.outcome.loop',
});
const REASON_KEYS: Readonly<Record<SimUnreachable, string>> = Object.freeze({
  invalid: 'sim.reason.invalid', 'too-long': 'sim.reason.too_long', scheme: 'sim.reason.scheme', ip: 'sim.reason.ip',
  port: 'sim.reason.port', host: 'sim.reason.host',
});

/** "Visit 2: 3 request(s); reached your server (attacker.test)." Requests actually sent; no URL. */
function visitLine(visit: SimVisit, n: number, lang: Lang): string {
  const tr = (key: string, vars: Readonly<Record<string, string | number>> = {}): string => fmt(t(key, lang), vars);
  const outcome = tr(OUTCOME_KEYS[visit.outcome], {
    status: visit.page?.status ?? '', n: SIM_LIMITS.maxRedirects, reason: tr(REASON_KEYS[visit.hops.at(-1)?.reason ?? 'invalid']),
  });
  return tr('sim.visit', { n, requests: visit.hops.filter((h) => h.site !== 'other').length, outcome });
}

function reportOf(world: World, lang: Lang): NonNullable<SimPanel['report']> {
  const { visits, dropped } = world.report;
  return {
    note: typeof world.noteText === 'string' ? world.noteText : world.noteText[lang],
    ...(world.failed ? { failed: t('sim.failed', lang) } : {}),
    ...(dropped > 0 ? { dropped: fmt(t('sim.visits_dropped', lang), { n: dropped }) } : {}),
    visits: visits.map((x) => visitLine(x.visit, x.n, lang)),
  };
}

function panelModel(v: VictimConfig, req: Request, res: Response): SimPanel {
  const world = worldOf(v, req);
  const lang: Lang = isLang(res.locals.lang) ? res.locals.lang : DEFAULT_LANG;
  const base = labPath(res);
  const level = req.level;
  return {
    hosts: fmt(t('sim.hosts', lang), { citadel: CITADEL_ORIGIN, attacker: ATTACKER_ORIGIN, lab: base }),
    actions: v.actions.map((a) => ({
      name: a.name, action: `${base}/victim/${a.name}?level=${level}`, label: a.label[lang], input: a.input === 'url',
      ...(a.description === undefined ? {} : { description: a.description[lang] }),
    })),
    lastLink: world.lastLink,
    ...(world.acted ? { report: reportOf(world, lang) } : {}),
    mailboxHeading: fmt(t('sim.mailbox', lang), { address: PLAYER_MAILBOX }),
    mails: world.inbox.list(PLAYER_MAILBOX).map((m) => ({
      from: m.from, subject: m.subject, at: iso(m.at), body: m.body,
      links: m.links.map((text) => {
        const href = labHref(classifySimUrl(text), base, level);
        return href === undefined ? { text } : { text, href };
      }),
    })),
    hits: [...world.attackerLog.entries()].reverse().map((h) => ({
      seq: h.seq, at: iso(h.at), method: h.method, url: h.url,
      ...(h.referer === undefined ? {} : { referer: h.referer }), ...(h.body === undefined ? {} : { body: h.body }),
    })),
  };
}

/** A victim action's note, checked and clipped: a string (lab content), bilingual Text, or '' for none. */
function noteOf(note: unknown, action: string): Text | string {
  if (note === undefined || note === null) return '';
  if (typeof note === 'string') return clip(note, SIM_LIMITS.noteLength);
  if (isText(note)) return Object.freeze({ id: clip(note.id, SIM_LIMITS.noteLength), en: clip(note.en, SIM_LIMITS.noteLength) });
  throw new Error(`victim action "${action}": run must return a string, bilingual text { id, en } or nothing`);
}

/**
 * A Location with no target, as a browser reads it: WHATWG drops tabs and newlines and strips leading and trailing C0
 * controls and spaces, so a Location made only of those (or empty) is blank. One anchored character class: linear
 * (a trim regex such as /^\s+|\s+$/ is quadratic on a long run of spaces inside a level-made Location).
 */
export function isBlankLocation(raw: string): boolean {
  return /^[\u0000-\u0020]*$/.test(raw);
}

/** The redirect statuses sendSimRedirect answers with (Fetch's redirect statuses). */
export type SimRedirectStatus = 301 | 302 | 303 | 307 | 308;
const awayView = join(dirname(fileURLToPath(import.meta.url)), 'views', 'sim-away.ejs');

/**
 * Answer the player's REAL browser with a Location a level function made, never sending it off the lab (a lab
 * route that answered `res.redirect(redirect_uri)` would be a real open redirect) nor back to itself. `location` is
 * resolved as the victim's browser would resolve it on the citadel twin of this route (`http://citadel.test<req.path>`);
 * a path under labPath(res) (a level function given base labPath(res)) is that path on the citadel.
 *
 * - A citadel URL: `status` (default 302) to the same place in the lab (labHref: `<labPath>/<path>?<query>` at the
 *   served level), e.g. the IdP's `302 http://citadel.test/callback?code=..` lands on `<lab>/callback?code=..`.
 * - No target (empty, blank or not a string): a 200 page saying the redirect has no target (never a loop to itself).
 * - Anything else (attacker.test, another host, `javascript:` ...): a 200 page (sendPage) that shows the URL as
 *   escaped text and says the simulated victim's browser goes there in this lab. It never links to it or follows it.
 */
export async function sendSimRedirect(res: Response, location: string, status: SimRedirectStatus = 302): Promise<void> {
  if (!REDIRECT_STATUSES.has(status)) throw new Error(`sendSimRedirect: status must be 301, 302, 303, 307 or 308 (got ${String(status)})`);
  const base = labPath(res);
  const raw = str(location);
  // No target (an empty, blank or non-string Location, e.g. an empty redirect_uri) would resolve to this very route
  // and redirect the browser to itself forever: say so instead.
  if (isBlankLocation(raw)) {
    await sendPage(res, awayView, { away: '' });
    return;
  }
  const local = raw === base || ['/', '?', '#'].some((c) => raw.startsWith(`${base}${c}`));
  const u = local
    ? classifySimUrl(`${CITADEL_ORIGIN}${raw.slice(base.length)}`)
    : classifySimUrl(raw, `${CITADEL_ORIGIN}${res.req.path}`);
  const href = labHref(u, base, res.req.level);
  if (href !== undefined) {
    res.redirect(status, href);
    return;
  }
  await sendPage(res, awayView, { away: u.url || clip(raw, SIM_LIMITS.urlLength) });
}

/**
 * Mount a challenge's victim (the engine calls this for `defineChallenge({ victim })`, before the lab's own
 * routes): the panel under every lab page rendered with sendPage, and `POST <lab>/victim/<name>` per action.
 */
export function mountVictim(router: Router, v: VictimConfig): void {
  router.use((req, res, next) => {
    res.locals.simPanel = () => panelModel(v, req, res); // built at render time, after the route changed state
    next();
  });
  for (const a of v.actions) {
    router.post(`/victim/${a.name}`, (req, res) => {
      const world = worldOf(v, req);
      const url = a.input === 'url' ? field(req, 'url') : '';
      world.beginAction(a.input === 'url' ? url : undefined);
      try {
        const note: unknown = a.run(req, Object.freeze({ url }));
        if (isThenable(note)) {
          note.then(undefined, () => {}); // never leave its rejection unhandled
          throw new Error(`victim action "${a.name}" must be synchronous (it returned a Promise)`);
        }
        world.noteText = noteOf(note, a.name);
        world.failed = false; // a throw leaves the report marked failed; the error goes to the error handler
      } finally {
        world.inAction = false;
      }
      res.redirect(303, `${labPath(res)}?level=${req.level}`);
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// XSS: the sink interpreter (docs/RECIPES.md, "XSS labs"). The victim's browser runs no JavaScript; the static oracle
// (core/xss/) decides, for every page the admin's browser renders, whether attacker bytes would have run the player's
// marker call. If so, the payload "sends the admin's cookie home": one request to the player's attacker log.

/** Where a payload that ran sends what it stole: `GET <XSS_STEAL_URL>?c=<canary>` in the player's attacker log. */
export const XSS_STEAL_URL = `${ATTACKER_ORIGIN}/steal`;

/** One player's marker at one level (newMarker()): the nonce, and the call a payload makes, `hvwa('<nonce>')`. */
export interface XssMarker { readonly nonce: string; readonly call: string }

/**
 * A fresh marker (16 CSPRNG hex digits). Make it in the lab's perSession factory, next to the world: one per player
 * and level, so a payload proves one player's exploit at one level. Throws outside a factory.
 */
export function newMarker(): XssMarker {
  if (!insidePerSessionFactory()) {
    throw new Error('newMarker: create it inside a perSession() factory (a marker belongs to one player at one level)');
  }
  const nonce = randomBytes(8).toString('hex');
  return Object.freeze({ nonce, call: markerCall(nonce) });
}

/** A page the admin's browser rendered, as a client-side twin sees it (XssVictimOptions.dom). Frozen. */
export interface XssPage {
  readonly url: string;
  readonly path: string;
  readonly query: URLSearchParams;
  /** `location.hash` as the browser has it ('#...', percent-encoded as WHATWG URLs encode a fragment, or ''). Never sent to the server. */
  readonly hash: string;
  readonly status: number;
  /** The page as the citadel answered it (the whole body, not the visit's clip). */
  readonly body: string;
}

/** What the page's own script writes into the DOM: the HTML, and how (default 'innerHTML': its scripts never run). */
export interface XssDomWrite { readonly html: string; readonly insertion?: XssInsertion }

export interface XssVictimOptions {
  /** The player's marker call (the lab's newMarker().call): only a payload that calls it counts. */
  readonly marker: string;
  /**
   * What the payload steals when it runs, e.g. the admin's session value. A function is read at that moment (a
   * signed-out admin has nothing to steal: `() => admin.cookies.get('session') ?? ''`). Sent URL-encoded.
   */
  readonly canary: string | (() => string);
  /** Sinks that need the admin to click, hover or focus count too (default true: the admin reads the page and uses it). */
  readonly interact?: boolean;
  /**
   * Client-rendered sinks (DOM XSS, prototype pollution): a twin of the page's own script, run for every page the
   * admin's browser renders, returns the HTML that script would write into the DOM (or undefined). The oracle judges
   * it too. The twin is lab code in the level file: the flaw lives there, the engine only judges its output. A twin
   * that throws wrote nothing, as a client script that throws writes nothing (the verdict says domFailed); one that
   * answers anything but { html, insertion? } or undefined is a programming error.
   */
  readonly dom?: (page: XssPage) => XssDomWrite | undefined;
}

/** The oracle's verdict on one rendered page (and on the twin's DOM write). Frozen; its URL is a copy. */
export interface XssPageVerdict {
  readonly url: string;
  readonly page: XssVerdict;
  readonly dom?: XssVerdict;
  /** The dom twin threw (on hostile input, say a malformed escape in the hash): it wrote nothing. */
  readonly domFailed?: true;
  /** The payload ran: the canary went to the attacker log. */
  readonly fired: boolean;
}

/** A victim's browser whose rendered pages run through the XSS oracle. */
export interface XssBrowser extends SimBrowser {
  /** The verdicts on the last SIM_LIMITS.visits pages it rendered, newest last (a test seam, and a lab's note). */
  readonly verdicts: readonly XssPageVerdict[];
}

/** Response headers by lower-case name. */
function headerLists(res: SimResponse): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
    if (list.length > 0) m.set(k.toLowerCase(), [...(m.get(k.toLowerCase()) ?? []), ...list]);
  }
  return m;
}

/**
 * How a browser renders the response: as an HTML document ('html': text/html, or no type, as labs answer by default),
 * as an XML document ('xml': image/svg+xml, application/xhtml+xml, text/xml, application/xml: read as XML, with
 * namespaces), or not as a document that can run script (undefined: any other type, or a download).
 */
function rendersDocument(h: Map<string, string[]>): 'html' | 'xml' | undefined {
  if (/^\s*attachment\b/i.test(h.get('content-disposition')?.[0] ?? '')) return undefined;
  const type = h.get('content-type')?.[0];
  if (type === undefined) return 'html';
  const essence = type.split(';')[0].trim().toLowerCase();
  if (essence === '' || essence === 'text/html') return 'html';
  return DOCUMENT_MIME_TYPES.has(essence) ? 'xml' : undefined;
}

/**
 * A `Content-Security-Policy: sandbox ...` on the response, as the tokens the page keeps (several policies all apply,
 * so only the tokens every one allows), or undefined when no policy sandboxes it. Only sandbox is modelled: other CSP
 * directives are not evaluated (a Divine level escapes; CSP is defence in depth, not the fix).
 */
function cspSandbox(values: readonly string[] | undefined): string | undefined {
  let allowed: Set<string> | undefined;
  for (const policy of (values ?? []).join(',').split(',')) {
    for (const directive of policy.split(';')) {
      const [name, ...tokens] = directive.trim().split(/[\t\n\f\r ]+/);
      if (name?.toLowerCase() !== 'sandbox') continue;
      const own = new Set(tokens.map((x) => x.toLowerCase()));
      allowed = allowed === undefined ? own : new Set([...allowed].filter((x) => own.has(x)));
    }
  }
  return allowed === undefined ? undefined : [...allowed].join(' ');
}

/** Where an attacker page a lab declared is (the browser checks it and throws for one off attacker.test). */
const pageOrigin = (page: Pick<SimAttackerPage, 'url'> | undefined): SimUrl => classifySimUrl(page?.url ?? ATTACKER_PAGE_URL);

/** The fragment of a URL as `location.hash` gives it ('' when there is none or the URL does not parse). A copy. */
function fragmentOf(url: unknown, base?: string): string {
  if (typeof url !== 'string' || url.length > SIM_LIMITS.urlLength) return '';
  try {
    return clip(base === undefined ? new URL(url).hash : new URL(url, base).hash, SIM_LIMITS.urlLength);
  } catch {
    return '';
  }
}

class XssVictimBrowser implements XssBrowser {
  private readonly inner: SimBrowser;
  /** The fragment of the navigation in progress: the link's, inherited across redirects that carry none (as browsers do). */
  private hash = '';
  private recent: XssPageVerdict[] = [];
  /**
   * Pages whose payload ran and whose steal is not logged yet: the canary is read once the browser has stored that
   * page's Set-Cookie (a script reads document.cookie after the response's cookies are set) and before the visit's next
   * request is answered, or when the visit ends. A Refresh hop to attacker.test is logged by the browser first.
   */
  private fired = 0;
  /** The attacker page around the frame the navigation in progress runs in, if it runs in one. */
  private framedIn: SimUrl | undefined;

  constructor(readonly world: SimWorld, handler: SimHandler, private readonly opts: XssVictimOptions) {
    // A page that fired earlier in this visit steals first: its cookies are stored by now, and the next page has not
    // answered yet (its handler may change what the payload could read).
    this.inner = world.browser((r) => { this.steal(); return this.render(r, handler(r)); });
  }

  get cookies(): SimCookieJar { return this.inner.cookies; }
  get verdicts(): readonly XssPageVerdict[] { return Object.freeze([...this.recent]); }

  follow(url: string, opts?: SimNavigateOptions): SimVisit {
    return this.navigation(url, () => this.inner.follow(url, opts));
  }

  submit(url: string, form: Readonly<Record<string, string>>, opts?: SimNavigateOptions): SimVisit {
    return this.navigation(url, () => this.inner.submit(url, form, opts));
  }

  crossSiteLink(url: string, opts?: SimCrossSiteOptions): SimVisit {
    return this.navigation(url, () => this.inner.crossSiteLink(url, opts), opts?.page?.sandboxed === true ? pageOrigin(opts.page) : undefined);
  }

  crossSitePost(url: string, form: SimFormFields, opts?: SimCrossSitePostOptions): SimVisit {
    return this.navigation(url, () => this.inner.crossSitePost(url, form, opts), opts?.page?.sandboxed === true ? pageOrigin(opts.page) : undefined);
  }

  frame(url: string, opts?: SimFrameOptions): SimFrame {
    return this.navigation(url, () => this.inner.frame(url, opts), pageOrigin(opts?.page));
  }

  clickThrough(frame: SimFrame, action: string, form: SimFormFields, opts?: SimClickOptions): SimClick {
    return this.navigation(action, () => this.inner.clickThrough(frame, action, form, opts), classifySimUrl(str(frame?.ancestor)));
  }

  /** A fetch is not a navigation: its answer is never rendered, so it is never judged and keeps the page's hash. */
  corsFetch(url: string, opts?: SimFetchOptions): SimFetch {
    try {
      return this.inner.corsFetch(url, opts);
    } finally {
      this.steal();
    }
  }

  /**
   * A navigation to `url`: its fragment is the page's location.hash; the pages that fired steal once it ends. In a
   * frame on the attacker's page (`framedIn`: that page), a page is judged only if the frame shows it: the browser
   * applies the same rule (framingOf) and never shows a page that refuses to be framed.
   */
  private navigation<T>(url: string, go: () => T, framedIn?: SimUrl): T {
    this.hash = fragmentOf(url);
    this.framedIn = framedIn;
    try {
      return go();
    } finally {
      this.framedIn = undefined;
      this.steal();
    }
  }

  /** Log the steals of the pages that fired, reading the canary now (the browser has stored their cookies). */
  private steal(): void {
    for (; this.fired > 0; this.fired--) {
      const { canary } = this.opts;
      const stolen = typeof canary === 'function' ? str(canary()) : canary;
      this.world.attackerLog.record({ method: 'GET', url: `${XSS_STEAL_URL}?c=${encodeURIComponent(stolen)}` });
    }
  }

  /** Every citadel answer passes here on its way to the browser, unchanged. A rendered page is judged first. */
  private render(r: SimRequest, res: SimResponse): SimResponse {
    if (res === null || typeof res !== 'object' || isThenable(res)) return res; // the browser reports it
    if (r.headers['sec-fetch-dest'] === 'empty') return res; // a fetch's answer (corsFetch): data for a script, never a page
    const h = headerLists(res);
    const location = REDIRECT_STATUSES.has(res.status) ? h.get('location')?.[0] : undefined;
    if (location !== undefined) { // a redirect is not a page; a Location with its own fragment replaces the link's
      const own = fragmentOf(location, r.url);
      if (own !== '') this.hash = own;
      return res;
    }
    const framed = this.framedIn === undefined || framingOf(h, classifySimUrl(r.url), [this.framedIn]) === 'allowed';
    const syntax = framed ? rendersDocument(h) : undefined; // a page that refuses the frame is never shown: nothing runs
    if (syntax !== undefined) this.judge(r, res, h, syntax);
    if (h.has('refresh')) this.hash = ''; // the next page is a new navigation
    return res;
  }

  private judge(r: SimRequest, res: SimResponse, h: Map<string, string[]>, syntax: 'html' | 'xml'): void {
    const { marker, interact = true, dom } = this.opts;
    const sandbox = cspSandbox(h.get('content-security-policy'));
    const options: XssOracleOptions = { interact, ...(sandbox === undefined ? {} : { sandbox }) };
    const body = typeof res.body === 'string' ? res.body : '';
    const page = xssOracle(body, marker, { ...options, syntax });
    let written: XssVerdict | undefined;
    let domFailed = false;
    if (dom !== undefined) {
      let w: unknown;
      try {
        w = dom(Object.freeze({ url: r.url, path: r.path, query: new URLSearchParams(r.query), hash: this.hash, status: res.status, body }));
      } catch {
        domFailed = true; // the client script threw on this input: it wrote nothing
      }
      if (w !== undefined) {
        const { html, insertion } = (w ?? {}) as Partial<XssDomWrite>;
        if (w === null || typeof w !== 'object' || typeof html !== 'string') {
          throw new Error('xssBrowser dom: the twin must return { html, insertion? } or undefined');
        }
        written = xssOracle(html, marker, { ...options, insertion: insertion ?? 'innerHTML' });
      }
    }
    const fired = page.executes || written?.executes === true;
    if (fired) this.fired++;
    // Bounded: SIM_LIMITS.visits verdicts of at most XSS_LIMITS.sinks sinks each (page and DOM write), every string a
    // copy; they weigh XSS_LIMITS.verdictsWeight in the shared byte budget (xssBrowser declares it).
    this.recent.push(Object.freeze({
      url: clip(r.url, SIM_LIMITS.urlLength), page, ...(written === undefined ? {} : { dom: written }),
      ...(domFailed ? { domFailed: true as const } : {}), fired,
    }));
    if (this.recent.length > SIM_LIMITS.visits) this.recent.shift();
  }
}

/**
 * The admin's browser for an XSS lab: `world.browser(handler)`, except that every page it renders (any answer but a
 * followed redirect, of a type a browser renders as a document, not a download) goes through `xssOracle(body, marker)`
 * first, and through the `dom` twin's output when the lab has one. When the oracle says the payload runs, one request
 * lands in the player's attacker log: `GET http://attacker.test/steal?c=<canary>` (no Referer). The page itself is
 * unchanged: the visit, the panel and the presets (checkMailAction, sendLinkAction) work as for any victim.
 * Create it in the lab's perSession factory (world.browser checks).
 */
export function xssBrowser(world: SimWorld, handler: SimHandler, opts: XssVictimOptions): XssBrowser {
  if (opts === null || typeof opts !== 'object') throw new Error('xssBrowser: options { marker, canary } are required');
  markerNonce(opts.marker); // throws for anything but a marker call
  if (typeof opts.canary !== 'string' && typeof opts.canary !== 'function') {
    throw new Error('xssBrowser: canary must be a string or a function () => string');
  }
  if (opts.interact !== undefined && typeof opts.interact !== 'boolean') throw new Error('xssBrowser: interact must be a boolean');
  if (opts.dom !== undefined && typeof opts.dom !== 'function') throw new Error('xssBrowser: dom must be a function (page) => { html } | undefined');
  if (typeof handler !== 'function') throw new Error('xssBrowser: handler must be a function');
  // Its kept verdicts are capped state too: the holder that keeps this browser weighs them in the shared byte budget,
  // on top of the world's stores and the browser's jar (which world.browser declares). Throws outside a factory.
  capPerSessionHolder('xssBrowser', { maxNewPerMinute: SIM_LIMITS.newWorldsPerMinute, weight: XSS_LIMITS.verdictsWeight });
  return new XssVictimBrowser(world, handler, Object.freeze({ ...opts }));
}
