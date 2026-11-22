// Flag submission (src/range/submit.ts, spec range §6): a flag counts only when it equals the flag of one of the
// SUBMITTING user's instances of that lab, created within the last 24 h; the level comes from that record. A flag
// copied from another user never matches. htmx gets the result fragment; a plain form a 303 back to the lab page.
import { describe, it, expect } from 'vitest';
import { FLAG_WINDOW_MS } from '../src/range/submit.js';
import { csrfOf } from './helpers.js';
import { player, portalApp, signInAs, PLAYER_PASSWORD, type Agent, type Kit } from './support/range.js';

async function launched(kit: Kit, userId: number, labId: string, level: 'acolyte' | 'templar' | 'inquisitor' | 'divine') {
  const r = await kit.app.locals.range!.lifecycle.launch(userId, labId, level);
  if (!r.ok) throw new Error(r.error);
  return kit.warden.launched.at(-1)!.flag; // what the lab container received as its one-shot flag
}
async function submit(agent: Agent, labId: string, flag: string, htmx = true) {
  const csrf = csrfOf((await agent.get(`/labs/${labId}`)).text);
  const req = agent.post(`/labs/${labId}/submit`).type('form');
  return (htmx ? req.set('HX-Request', 'true') : req).send({ _csrf: csrf, submission: flag });
}
const result = (html: string) => /data-result="([a-z_]+)"/.exec(html)?.[1];

describe('POST /labs/:id/submit', () => {
  it('the flag of my own instance scores its level (Templar of an Easy lab: 150) and lands on the leaderboard', async () => {
    const kit = portalApp();
    const alice = await player(kit.app, 'alice');
    const flag = await launched(kit, alice.userId, 'r01', 'templar');
    const res = await submit(alice.agent, 'r01', `  ${flag}  `);
    expect(result(res.text)).toBe('new_best');
    expect(res.text).toContain('+150');
    expect((await alice.agent.get('/')).text).toContain('data-testid="range-score">150<');
    expect((await alice.agent.get('/leaderboard')).text).toContain('data-user="alice"');
  });

  it('the htmx result carries the toast payload (solved / already / wrong), read by ui.js after the swap', async () => {
    const kit = portalApp();
    const alice = await player(kit.app, 'alice');
    const flag = await launched(kit, alice.userId, 'r01', 'templar');
    const solved = await submit(alice.agent, 'r01', `  ${flag}  `);
    expect(solved.text).toMatch(/data-toast="solved"/);
    expect(solved.text).toMatch(/data-toast-variant="success"/);
    expect(solved.text).toMatch(/data-level="templar"/);
    expect(solved.text).toMatch(/data-points="150"/);
    expect(solved.text).toContain('Bounty claimed');
    const already = await submit(alice.agent, 'r01', flag!);
    expect(already.text).toMatch(/data-toast="already"/);
    expect(already.text).toMatch(/data-toast-variant="info"/);
    const wrong = await submit(alice.agent, 'r01', `HVWA{${'a'.repeat(26)}}`);
    expect(wrong.text).toMatch(/data-toast="wrong"/);
    expect(wrong.text).toMatch(/data-toast-variant="error"/);
  });

  it('the htmx result carries the submit-result modal payload: variant, title, message, points, and a fact only for a new best', async () => {
    const kit = portalApp();
    const alice = await player(kit.app, 'alice');
    const templar = await launched(kit, alice.userId, 'r01', 'templar');
    const solved = await submit(alice.agent, 'r01', `  ${templar}  `);
    expect(solved.text).toMatch(/data-modal="solved"/);
    expect(solved.text).toContain('data-modal-title="Contract sealed"');
    expect(solved.text).toContain('data-modal-message="Templar sealed"');
    expect(solved.text).toContain('data-modal-points="+150"');
    expect(solved.text).toMatch(/data-modal-fact="SQL injection has appeared/);
    const already = await submit(alice.agent, 'r01', templar!);
    expect(already.text).toMatch(/data-modal="already"/);
    expect(already.text).toContain('data-modal-title="Already sealed"');
    expect(already.text).toMatch(/data-modal-fact=""/);
    const wrong = await submit(alice.agent, 'r01', `HVWA{${'a'.repeat(26)}}`);
    expect(wrong.text).toMatch(/data-modal="wrong"/);
    expect(wrong.text).toContain('data-modal-title="The seal did not take"');
    expect(wrong.text).toContain('data-modal-message="No matching mark in the ledger');
    expect(wrong.text).toMatch(/data-modal-fact=""/);
    const acolyte = await launched(kit, alice.userId, 'r01', 'acolyte'); // replaces the Templar instance
    const lower = await submit(alice.agent, 'r01', acolyte!);
    expect(lower.text).toMatch(/data-modal="lower"/);
    expect(lower.text).toContain('data-modal-title="Seal held"');
    expect(lower.text).toMatch(/data-modal-fact=""/);
  });

  it('another user\'s flag never counts, either way; nor a flag of another lab; nor a made-up one', async () => {
    const kit = portalApp();
    const alice = await player(kit.app, 'alice');
    const bob = await player(kit.app, 'bob');
    const aliceFlag = await launched(kit, alice.userId, 'r01', 'acolyte');
    const bobFlag = await launched(kit, bob.userId, 'r01', 'acolyte');
    expect(result((await submit(bob.agent, 'r01', aliceFlag!)).text)).toBe('wrong');
    expect(result((await submit(alice.agent, 'r01', bobFlag!)).text)).toBe('wrong');
    expect(result((await submit(alice.agent, 'r02', aliceFlag!)).text)).toBe('wrong');
    expect(result((await submit(alice.agent, 'r01', `HVWA{${'a'.repeat(26)}}`)).text)).toBe('wrong');
    expect(result((await submit(alice.agent, 'r01', '')).text)).toBe('wrong');
  });

  it('already / lower; a stopped instance\'s flag still counts within 24 h, not after', async () => {
    const kit = portalApp();
    const alice = await player(kit.app, 'alice');
    const templar = await launched(kit, alice.userId, 'r01', 'templar');
    const acolyte = await launched(kit, alice.userId, 'r01', 'acolyte'); // replaces the Templar instance
    expect(result((await submit(alice.agent, 'r01', templar!)).text)).toBe('new_best');
    expect(result((await submit(alice.agent, 'r01', templar!)).text)).toBe('already');
    expect(result((await submit(alice.agent, 'r01', acolyte!)).text)).toBe('lower');
    const late = await launched(kit, alice.userId, 'r01', 'inquisitor');
    await kit.app.locals.range!.lifecycle.stop(alice.userId);
    kit.clock.advance(FLAG_WINDOW_MS + 1);
    // The sign-in token's own lifetime is 12 h, so a browser 24 h on signs in again first (the flag window is the subject).
    const later = await signInAs(kit.app, 'alice', PLAYER_PASSWORD);
    expect(result((await submit(later, 'r01', late!)).text)).toBe('wrong');
  });

  it('Divine issues no flag; a plain form gets a 303 and the page shows the result; the account CSRF token is required', async () => {
    const kit = portalApp();
    const alice = await player(kit.app, 'alice');
    expect(await launched(kit, alice.userId, 'r01', 'divine')).toBeUndefined();
    const flag = await launched(kit, alice.userId, 'r01', 'acolyte');
    const plain = await submit(alice.agent, 'r01', flag!, false);
    expect(plain.status).toBe(303);
    expect(plain.headers.location).toBe('/labs/r01?r=solved');
    expect((await alice.agent.get('/labs/r01?r=solved')).text).toContain('data-result="solved"');
    expect((await submit(alice.agent, 'r01', 'nope', false)).headers.location).toBe('/labs/r01?r=wrong');
    expect((await alice.agent.post('/labs/r01/submit').type('form').send({ submission: flag })).status).toBe(403);
  });
});
