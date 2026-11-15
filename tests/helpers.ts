// tests/helpers.ts — shared test utilities.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';

/** Flag secret used by tests that pass one explicitly (>= 16 chars, like FLAG_SECRET). */
export const TEST_SECRET = 'hvwa-test-flag-secret';

function setCookieLines(res: request.Response): string[] {
  const raw: unknown = res.headers['set-cookie'];
  if (Array.isArray(raw)) return raw.map(String);
  return typeof raw === 'string' ? [raw] : [];
}

/** Full Set-Cookie line for cookie `name`, or undefined if the response did not set it. */
export function setCookieHeader(res: request.Response, name: string): string | undefined {
  return setCookieLines(res).find((line) => line.startsWith(`${name}=`));
}

/** Decoded value of cookie `name` from the response's Set-Cookie headers. */
export function setCookieValue(res: request.Response, name: string): string | undefined {
  const line = setCookieHeader(res, name);
  return line === undefined ? undefined : decodeURIComponent(line.slice(name.length + 1).split(';')[0]);
}

/**
 * A supertest agent on `app` (default: a fresh app with TEST_SECRET) whose
 * session is established by its first request; the sid is read from the
 * hvwa_sid cookie by name.
 */
export async function freshSession(app: Express = createApp({ flagSecret: TEST_SECRET })) {
  const agent = request.agent(app);
  const res = await agent.get('/healthz');
  const sid = setCookieValue(res, 'hvwa_sid');
  if (!sid) throw new Error('first response did not set hvwa_sid');
  return { app, agent, sid };
}

/** Text-source extensions the hygiene checks apply to. */
const TEXT_EXT = /\.(ts|mts|mjs|js|ejs|css|sql|json|md)$/i;

/**
 * Repo-hygiene scan: relative paths (under `dirs` of `root`) of text-source
 * files that are not valid UTF-8, or that contain control characters other
 * than tab/LF/CR. Convention: labs put deliberately binary or malformed files
 * under `<challenge>/fixtures/`; any path segment named `fixtures` is exempt,
 * as are all non-text extensions.
 */
export function hygieneProblems(root: string, dirs: string[]): { badUtf8: string[]; control: string[] } {
  const badUtf8: string[] = [];
  const control: string[] = [];
  for (const dir of dirs) {
    for (const rel of readdirSync(join(root, dir), { recursive: true }).map(String)) {
      if (!TEXT_EXT.test(rel) || rel.split(/[\\/]/).includes('fixtures')) continue;
      const p = join(root, dir, rel);
      if (!statSync(p).isFile()) continue;
      const bytes = readFileSync(p);
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { badUtf8.push(`${dir}/${rel}`); }
      if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(bytes.toString('latin1'))) control.push(`${dir}/${rel}`);
    }
  }
  return { badUtf8, control };
}
