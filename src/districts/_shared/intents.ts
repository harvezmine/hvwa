// src/districts/_shared/intents.ts — intent routing for lab landing pages, any district: a page's forms post back to the
// lab root with no `action` and a hidden `intent`, and each intent also has its own path for curl and scripts.
// Plumbing only (Relic Market's shop labs, the Archive's API labs): the decisions stay in the lab's levels/*.ts.
// Moved here from relic-market/_shared/shop-lab.ts (owner decision Q15); that file re-exports it unchanged.
import type { Request, Response, Router } from 'express';
import { field } from '../../core/lab.js';
import type { Result } from './result.js';

/**
 * What an intent came to: the message to show and, optionally, the response status. mountIntents adds `intent`, the
 * name of the intent that ran (undefined for an unknown action), before it calls render.
 */
export interface Outcome { readonly result: Result | null; readonly status?: number; readonly intent?: string }

/** One action of a lab page: a hidden `intent` on `POST /`, and its own path (`POST <lab><path>`) for curl. */
export interface Intent {
  readonly path: string;
  /** The body fields it reads, for the page's endpoint list (documentation only). */
  readonly fields?: readonly string[];
  readonly run: (req: Request, res: Response) => Outcome | Promise<Outcome>;
}

/** An intent's own door, as the page's endpoint list shows it. */
export interface Endpoint { readonly method: 'POST'; readonly path: string; readonly intent: string; readonly fields: readonly string[] }

/** The doors of an intent table, in its order. */
export function endpointsOf(intents: Readonly<Record<string, Intent>>): Endpoint[] {
  return Object.entries(intents).map(([intent, i]) => ({ method: 'POST', path: i.path, intent, fields: [...(i.fields ?? [])] }));
}

/** Paths an intent may not take: POST / dispatches, and the engine mounts Restart and the victim's actions. */
const isReserved = (path: string): boolean => path === '/' || path === '/_reset' || path === '/victim' || path.startsWith('/victim/');

/** Renders the lab page after an intent ran. */
export type Render = (req: Request, res: Response, outcome: Outcome) => Promise<void>;

/** The answer to a missing or unknown intent (200, never a 500). */
export const UNKNOWN_ACTION: Result = Object.freeze({ ok: false, text: 'Unknown action.' });

/** An intent's refusal. */
export const refusal = (text: string): Outcome => ({ result: { ok: false, text } });
/** An intent's success. */
export const success = (text: string): Outcome => ({ result: { ok: true, text } });

/**
 * Mount a shop page's actions: `POST /` dispatches on the body's `intent` field (the page's forms post back with no
 * action and a hidden intent), and each intent is also mounted on its own path. Then `render` draws the page with the
 * outcome and the intent's name. A missing, unknown or non-string intent answers 200 with UNKNOWN_ACTION. Throws at
 * mount time on a path that is relative, repeated, `/`, or one of the engine's (`/_reset`, `/victim/...`). Returns the
 * table's endpoints (endpointsOf).
 */
export function mountIntents(router: Router, intents: Readonly<Record<string, Intent>>, render: Render): Endpoint[] {
  const table = new Map(Object.entries(intents)); // a Map: `constructor` or `__proto__` is no intent
  const paths = new Set<string>();
  for (const [name, i] of table) {
    if (!i.path.startsWith('/') || isReserved(i.path)) throw new Error(`mountIntents: intent "${name}" may not use the path "${i.path}"`);
    if (paths.has(i.path)) throw new Error(`mountIntents: two intents use the path "${i.path}"`);
    paths.add(i.path);
  }
  const answer = async (req: Request, res: Response, name: string | undefined): Promise<void> => {
    const intent = name === undefined ? undefined : table.get(name);
    const outcome: Outcome = intent === undefined ? { result: UNKNOWN_ACTION } : await intent.run(req, res);
    if (outcome.status !== undefined) res.status(outcome.status);
    await render(req, res, { ...outcome, intent: intent === undefined ? undefined : name });
  };
  router.post('/', async (req, res) => { await answer(req, res, field(req, 'intent')); });
  for (const [name, intent] of table) {
    router.post(intent.path, async (req, res) => { await answer(req, res, name); });
  }
  return endpointsOf(intents);
}
