// The Lab panel (src/range/panel.ts, lab-routes.ts, spec range §10): state, time left, Launch / Open lab / Reset / Stop,
// htmx polling (1 s starting, 30 s running) and "My Lab" in the header on every page. Compact POC (plan amendment): no
// FIFO queue (a full range refuses) and no Extend, and there is no admin instances page.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { csrfOf } from './helpers.js';
import { fakeWarden } from './support/fake-warden.js';
import { DOMAIN, player, portalApp, type Agent } from './support/range.js';

const panelOf = (html: string) => /<section id="lab-panel"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
const stateOf = (html: string) => /data-testid="lab-panel" data-state="([a-z]+)"/.exec(html)?.[1];
async function act(agent: Agent, labId: string, action: string, level = 'acolyte', htmx = true) {
  const csrf = csrfOf((await agent.get(`/labs/${labId}?level=${level}`)).text);
  const req = agent.post(`/labs/${labId}/${action}`).type('form');
  return (htmx ? req.set('HX-Request', 'true') : req).send({ _csrf: csrf, level });
}

describe('the Lab panel', () => {
  it('none -> Launch -> starting (polls every 1 s) -> running (polls every 30 s): time left, Open, Reset, Stop', async () => {
    const kit = portalApp();
    const { agent } = await player(kit.app, 'alice');
    const page = panelOf((await agent.get('/labs/r01?level=acolyte')).text);
    expect(stateOf(page)).toBe('none');
    expect(page).toContain('data-testid="lab-launch"');
    expect(page).not.toContain('hx-trigger');
    const started = await act(agent, 'r01', 'launch');
    expect(started.status).toBe(200);
    expect(stateOf(started.text)).toBe('starting');
    expect(started.text).toContain('hx-trigger="every 1s"');
    const polled = (await agent.get('/labs/r01/panel?level=acolyte').set('HX-Request', 'true')).text; // refresh: fake warden is ready
    expect(stateOf(polled)).toBe('running');
    expect(polled).toContain('hx-trigger="every 30s"');
    expect(polled).toContain('data-testid="time-left">60 min left<');
    for (const hook of ['lab-open', 'lab-reset', 'lab-stop']) expect(polled).toContain(`data-testid="${hook}"`);
    expect(polled).not.toContain('lab-extend');
    expect(polled).not.toContain('queue-position');
  });

  it('Launch needs the account CSRF token; a plain form gets a 303 to the lab page at that level', async () => {
    const kit = portalApp();
    const { agent } = await player(kit.app, 'alice');
    expect((await agent.post('/labs/r01/launch').type('form').send({ level: 'acolyte' })).status).toBe(403);
    expect(kit.warden.launched).toEqual([]);
    const plain = await act(agent, 'r01', 'launch', 'templar', false);
    expect(plain.status).toBe(303);
    expect(plain.headers.location).toBe('/labs/r01?level=templar');
    expect((await act(agent, 'r01', 'launch', 'nope')).status).toBe(400);
  });

  it('Open lab: a 303 to the instance host\'s gate with a fresh ticket, which the gate accepts (the full hop)', async () => {
    const kit = portalApp({ range: { publicPort: 18443 } });
    const { agent } = await player(kit.app, 'alice');
    await act(agent, 'r01', 'launch');
    await agent.get('/labs/r01/panel?level=acolyte');
    const open = await act(agent, 'r01', 'open', 'acolyte', false);
    expect(open.status).toBe(303);
    expect(open.headers['cache-control']).toBe('no-store');
    const location = new URL(open.headers.location as string);
    expect(location.origin).toMatch(new RegExp(`^https://i-[a-z2-7]{26}\\.${DOMAIN.replace('.', '\\.')}:18443$`));
    expect(location.pathname).toBe('/__hvwa/gate');
    const hop = await request(kit.app).get(`${location.pathname}${location.search}`).set('Host', location.host);
    expect(hop.status).toBe(303);
    expect(hop.headers['set-cookie']?.[0]).toMatch(/^hvwa_gate=v1\./);
  });

  it('Open lab without a running instance of this lab goes back to the lab page', async () => {
    const kit = portalApp();
    const { agent } = await player(kit.app, 'alice');
    const open = await act(agent, 'r01', 'open', 'acolyte', false);
    expect(open.headers.location).toBe('/labs/r01');
  });

  it('Reset is a new instance; Stop removes it; an action on another lab\'s panel changes nothing', async () => {
    const kit = portalApp();
    const { agent, userId } = await player(kit.app, 'alice');
    await act(agent, 'r01', 'launch');
    await agent.get('/labs/r01/panel?level=acolyte');
    const before = kit.app.locals.range!.lifecycle.current(userId)!.id;
    await act(agent, 'r02', 'stop');
    expect(kit.app.locals.range!.lifecycle.current(userId)?.id).toBe(before);
    await act(agent, 'r01', 'reset');
    expect(kit.app.locals.range!.lifecycle.current(userId)?.id).not.toBe(before);
    const stopped = await act(agent, 'r01', 'stop');
    expect(stateOf(stopped.text)).toBe('none');
    expect(kit.warden.boxes.size).toBe(0);
  });

  it('a full range refuses: the panel says so, with Launch again and no queue', async () => {
    const kit = portalApp({ range: { limits: { capacity: 1, idleMs: 20 * 60_000, maxMs: 60 * 60_000, startTimeoutMs: 90_000 } } });
    const alice = await player(kit.app, 'alice');
    const bob = await player(kit.app, 'bob');
    await act(alice.agent, 'r01', 'launch');
    const full = await act(bob.agent, 'r01', 'launch');
    expect(stateOf(full.text)).toBe('none');
    expect(full.text).toContain('data-testid="range-full"');
    expect(full.text).toContain('The range is full. Try again in a minute.');
    expect(full.text).toContain('data-testid="lab-launch"');
    expect(full.text).not.toContain('queue-position');
  });

  it('a failed launch shows its reason and Launch again; another lab running is named before replacing it', async () => {
    const warden = fakeWarden({ autoReady: true });
    const kit = portalApp({ warden });
    const { agent } = await player(kit.app, 'alice');
    warden.failNextLaunch('docker');
    const failed = await act(agent, 'r01', 'launch');
    expect(stateOf(failed.text)).toBe('failed');
    expect(failed.text).toContain('data-reason="docker"');
    expect(failed.text).toContain('data-testid="lab-launch"');
    await act(agent, 'r01', 'launch');
    const other = panelOf((await agent.get('/labs/r02')).text);
    expect(stateOf(other)).toBe('none');
    expect(other).toContain('data-testid="lab-replaces"');
    expect(other).toContain('App clinic');
  });
});

describe('My Lab in the header', () => {
  it('says "none" without an instance; names the app and the time left while running; /my-lab goes to it', async () => {
    const kit = portalApp();
    const { agent } = await player(kit.app, 'alice');
    expect((await agent.get('/leaderboard')).text).toMatch(/data-testid="my-lab" data-state="none"/);
    expect((await agent.get('/my-lab')).headers.location).toBe('/');
    await act(agent, 'r01', 'launch', 'templar');
    await agent.get('/labs/r01/panel?level=templar');
    const html = (await agent.get('/leaderboard')).text;
    expect(html).toMatch(/data-testid="my-lab" data-state="running"/);
    expect(html).toContain('App clinic · 60 min left');
    expect((await agent.get('/my-lab')).headers.location).toBe('/labs/r01?level=templar');
    const chip = await agent.get('/my-lab/chip').set('HX-Request', 'true');
    expect(chip.text.trim()).toMatch(/^<a class="my-lab"/);
    expect(chip.text).not.toContain('<!doctype html>');
  });
});
