// src/core/sim.ts — the simulated victim for victim-driven labs (reset emails the admin clicks, OAuth redirects,
// session links): two fictional hosts, a per-player inbox, the player's attacker-server log and a tiny browser.
//
// Deterministic, and NO real network: nothing in core/sim/ opens a socket, resolves a name or fetches. citadel.test
// requests are answered IN PROCESS by a handler the lab builds from its own level functions; attacker.test
// requests are appended to the player's log; every other host is unreachable. Labs that TEACH URL-parsing flaws
// do their own (flawed) checks in their level files: classifySimUrl() is the ground truth for where the victim's
// browser actually went.
//
// This file only re-exports, so labs import one module:
//   core/sim/limits.ts   SIM_LIMITS and the copying clip
//   core/sim/url.ts      the two hosts, classifySimUrl, labHref
//   core/sim/cookies.ts  the victim's cookie jar
//   core/sim/browser.ts  SimBrowser: the navigation loop, REDIRECT_STATUSES
//   core/sim/world.ts    simWorld, simInbox, attackerLog (pure simulation: no Express at runtime)
//   core/sim/cross.ts    the browser rules across sites: Origin, Sec-Fetch, form bodies, CORS, framing
//   core/victim.ts       the engine side: VictimConfig, the presets, the panel, mountVictim, sendSimRedirect
//   core/twin.ts         one lab app, two browsers: Reply (toSim / sendReply), TwinCookie, the forward note, Visit
export { SIM_LIMITS } from './sim/limits.js';
export {
  ATTACKER_HOST, ATTACKER_ORIGIN, CITADEL_HOST, CITADEL_ORIGIN, classifySimUrl, labHref,
  type SimSite, type SimUnreachable, type SimUrl,
} from './sim/url.js';
export type { SimCookie, SimCookieContext, SimCookieJar, SimCookieOptions, SimSameSite } from './sim/cookies.js';
export {
  ATTACKER_PAGE_URL, REDIRECT_STATUSES, SIM_USER_AGENT,
  type SimAttackerPage, type SimBrowser, type SimCrossSiteOptions, type SimCrossSitePostOptions, type SimFetch, type SimFetchOptions,
  type SimClick, type SimClickOptions, type SimFetchVerdict, type SimFrame, type SimFrameOptions, type SimHandler, type SimHop,
  type SimNavigateOptions, type SimOutcome, type SimRequest, type SimResponse, type SimVisit,
} from './sim/browser.js';
export { SIM_FORM_BOUNDARY, type SimCorsRead, type SimFormEnctype, type SimFormFields, type SimFraming } from './sim/cross.js';
export {
  ADMIN_MAILBOX, PLAYER_MAILBOX, attackerLog, simInbox, simWorld,
  type AttackerHit, type AttackerLog, type AttackerRequest, type NewMail, type SimInbox, type SimInboxOptions, type SimMail,
  type SimWorld, type SimWorldOptions,
} from './sim/world.js';
export {
  ATTACKER_EXFIL_URL, VICTIM_LABELS, assertVictimConfig, checkMailAction, frameAndClickAction, mountVictim, sendAttackerPageAction,
  sendLinkAction, sendSimRedirect, visitAttackerPageAction,
  type AttackerPageOptions, type AttackerScript, type AttackerStep, type FrameAndClickOptions, type FramedForm, type FramedPage,
  type CheckMailOptions, type SimPanel, type SimRedirectStatus, type VictimAction, type VictimConfig, type VictimPresetOptions,
  type VictimRearm,
} from './victim.js';
export {
  TWIN_LIMITS, VISIT_HEADERS, cookiePath, forwardNote, sendReply, simVisitOf, toSim, twinBody, visitOf,
  type ForwardNote, type Reply, type RequestVisit, type TwinCookie, type TwinSameSite, type Visit,
} from './twin.js';
