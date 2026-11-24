// The story quests (src/quest): chapters unlock in order, a chapter's scenes and evidence leave the server only once
// it is unlocked, the scenes after a challenge only once the answer is right, answers are checked on the server
// (normalised, throttled), and a challenge's "archive" drop answers 404 until its chapter is open. Plus the story's
// own integrity: every picture, portrait, track and effect it names exists, and every line is in both languages.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalise, WRONG_PER_MINUTE } from '../src/quest/index.js';
import { SILENT_FRIDAY } from '../src/quest/silent-friday/story.js';
import type { Step, Text } from '../src/quest/types.js';
import { portalApp, player, type Agent } from './support/range.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const Q = '/quests/silent-friday';
const csrfOf = (html: string) => /"csrf":"([^"]+)"/.exec(html)![1]!;

async function journal(agent: Agent) {
  const page = await agent.get(Q);
  expect(page.status).toBe(200);
  return { html: page.text, csrf: csrfOf(page.text) };
}
const answer = (agent: Agent, n: number, csrf: string, a?: string) =>
  agent.post(`${Q}/chapter/${n}`).set('Accept', 'application/json').send(a === undefined ? { _csrf: csrf } : { _csrf: csrf, answer: a });

describe('quest answers', () => {
  it('compare without case, spaces, punctuation or leetspeak', () => {
    expect(normalise("{th3 d3v1l's r1ght h4nd}")).toBe('thedevilsrighthand');
    expect(normalise('  Theme-Park  ARANDELLE! ')).toBe('themeparkarandelle');
    expect(normalise('   ')).toBe('');
  });
});

describe('the Silent Friday quest', () => {
  it('the forensics board pins the Grand Quest, and the journal opens with only the prologue playable', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'reader');
    const hall = await agent.get('/');
    expect(hall.text).toContain('data-testid="quest-card"');
    expect(hall.text).toContain(`href="${Q}"`);
    const { html } = await journal(agent);
    expect(html).toContain('data-own-music');
    expect(html).toContain('class="chapter-card is-open" data-chapter="0"');
    expect(html).toContain('class="chapter-card is-locked" data-chapter="1"');
    // A locked chapter's name and cover stay hidden, in the page and in the boot data.
    expect(html).not.toContain('Praise for the Hero');
    expect(html).not.toContain('/bg/girl.webp');
  });

  it('serves a chapter only once unlocked; the prologue is done when the player accepts it (with the form token)', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'reader');
    const { csrf } = await journal(agent);
    expect((await agent.get(`${Q}/chapter/1`)).status).toBe(404);
    expect((await agent.get(`${Q}/chapter/9`)).status).toBe(404);
    const zero = await agent.get(`${Q}/chapter/0`);
    expect(zero.status).toBe(200);
    expect(zero.body.challenge).toBeUndefined();
    expect(Array.isArray(zero.body.pre)).toBe(true);
    expect((await answer(agent, 0, 'forged')).status).toBe(403);
    expect((await agent.get(`${Q}/chapter/1`)).status).toBe(404);
    expect((await answer(agent, 0, csrf)).body).toEqual({ ok: true });
    const one = await agent.get(`${Q}/chapter/1`);
    expect(one.status).toBe(200);
    expect(one.body.done).toBe(false);
    expect(one.body.post).toBeUndefined();
    expect(one.body.challenge.evidence[0].href).toBe(`${Q}/evidence/1/memory-crystal.png`);
    expect(JSON.stringify(one.body)).not.toMatch(/arandelle/i); // the answer is not in what the player is sent
    expect(one.body.recap).toMatch(/Little Lantern House/);
    expect(one.body.recapPost).toBeUndefined();
  });

  it('speaks the player\'s language', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'reader');
    const id = await agent.get(`${Q}/chapter/0?lang=id`);
    expect(JSON.stringify(id.body)).toContain('Pahlawan Perdamaian');
    expect(JSON.stringify(id.body)).not.toContain('Hero of Peace');
  });

  it('hands over the evidence of an unlocked chapter only, as a download of the exact file', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'reader');
    const { csrf } = await journal(agent);
    expect((await agent.get(`${Q}/evidence/1/memory-crystal.png`)).status).toBe(404);
    await answer(agent, 0, csrf);
    const file = await agent.get(`${Q}/evidence/1/memory-crystal.png`).buffer(true);
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toBe('attachment; filename="memory-crystal.png"');
    expect(Buffer.compare(file.body as Buffer, readFileSync(join(root, 'src/quest/silent-friday/evidence/chall1.png')))).toBe(0);
    expect((await agent.get(`${Q}/evidence/1/../../story.ts`)).status).toBe(404);
  });

  it('checks answers on the server: wrong ones are refused, a right one opens the next chapter and sends the scenes after it', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'reader');
    const { csrf } = await journal(agent);
    await answer(agent, 0, csrf);
    expect((await answer(agent, 1, csrf, 'the circus')).body).toEqual({ ok: false, error: 'wrong' });
    expect((await answer(agent, 1, csrf, '')).body).toEqual({ ok: false, error: 'wrong' });
    expect((await agent.get(`${Q}/chapter/2`)).status).toBe(404);
    const right = await answer(agent, 1, csrf, 'theme park arandelle');
    expect(right.body.ok).toBe(true);
    expect(JSON.stringify(right.body.post)).toContain('Theme Park Arandelle');
    expect(right.body.recapPost).toMatch(/Arandelle/);
    expect((await agent.get(`${Q}/chapter/1`)).body.post).toBeDefined(); // a replay gets the whole chapter
    expect((await agent.get(`${Q}/chapter/2`)).status).toBe(200);
  });

  it('the address on the paper answers 404 until chapter II is open, then lists and serves the file', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'reader');
    const { csrf } = await journal(agent);
    const archive = '/im4ges/foren/themepark/13';
    expect((await agent.get(`${archive}/`)).status).toBe(404);
    expect((await agent.get(`${archive}/chall2.txt`)).status).toBe(404);
    await answer(agent, 0, csrf);
    await answer(agent, 1, csrf, 'Arandelle');
    const index = await agent.get(`${archive}/`);
    expect(index.status).toBe(200);
    expect(index.text).toContain('href="chall2.txt"');
    expect((await agent.get(archive)).status).toBe(301);
    const file = await agent.get(`${archive}/chall2.txt`).buffer(true);
    expect(file.status).toBe(200);
    expect((file.body as Buffer).subarray(0, 4).toString('latin1')).toBe('\x89PNG'); // a picture wearing a .txt
    expect((await answer(agent, 2, csrf, "{th3 d3v1l's r1ght h4nd}")).body.ok).toBe(true);
  });

  it('slows a player down after too many wrong guesses in a minute', async () => {
    const { app, clock } = portalApp();
    const { agent } = await player(app, 'reader');
    const { csrf } = await journal(agent);
    await answer(agent, 0, csrf);
    for (let i = 0; i < WRONG_PER_MINUTE; i++) expect((await answer(agent, 1, csrf, `guess ${i}`)).body.error).toBe('wrong');
    const slow = await answer(agent, 1, csrf, 'theme park arandelle');
    expect(slow.status).toBe(429);
    clock.advance(61_000);
    expect((await answer(agent, 1, csrf, 'theme park arandelle')).body.ok).toBe(true);
  });

  it('chapter III: Exhibit 7 is handed over once chapter II is done, and its revealed note is sealed until the case is solved', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'reader');
    const { csrf } = await journal(agent);
    const sealed = `${Q}/sealed/3/exhibit-full.webp`;
    await answer(agent, 0, csrf);
    await answer(agent, 1, csrf, 'arandelle');
    expect((await agent.get(`${Q}/evidence/3/exhibit-7.png`)).status).toBe(404);
    await answer(agent, 2, csrf, 'the devils right hand');
    const ex = await agent.get(`${Q}/evidence/3/exhibit-7.png`).buffer(true);
    expect(ex.status).toBe(200);
    // The file claims 1024 rows (IHDR height at byte 20); the hidden rows are the challenge.
    expect((ex.body as Buffer).readUInt32BE(20)).toBe(1024);
    expect((await agent.get(sealed)).status).toBe(404);
    expect(JSON.stringify((await agent.get(`${Q}/chapter/3`)).body)).not.toMatch(/old circus/i);
    expect((await answer(agent, 3, csrf, 'the circus of valeria')).body.ok).toBe(false);
    const right = await answer(agent, 3, csrf, 'The Old Circus');
    expect(right.body.ok).toBe(true);
    expect(JSON.stringify(right.body.post)).toContain('sealed:exhibit-full');
    const pic = await agent.get(sealed);
    expect(pic.status).toBe(200);
    expect(pic.headers['content-type']).toMatch(/image\/webp/);
    expect((await agent.get(`${Q}/sealed/3/other.webp`)).status).toBe(404);
    expect((await agent.get(`${Q}/sealed/2/exhibit-full.webp`)).status).toBe(404);
  });

  it('progress is per player', async () => {
    const { app } = portalApp();
    const a = await player(app, 'first');
    const b = await player(app, 'second');
    await answer(a.agent, 0, (await journal(a.agent)).csrf);
    expect((await a.agent.get(`${Q}/chapter/1`)).status).toBe(200);
    expect((await b.agent.get(`${Q}/chapter/1`)).status).toBe(404);
  });
});

describe('the story', () => {
  const pub = join(root, 'src/public');
  const steps: Step[] = [];
  (function walk(list: readonly Step[]) {
    for (const s of list) {
      steps.push(s);
      if ('choice' in s) s.choice.forEach((c) => walk(c.then));
      if ('explore' in s) s.explore.spots.forEach((c) => walk(c.then));
    }
  })(SILENT_FRIDAY.chapters.flatMap((c) => [...c.pre, ...(c.post ?? [])]));
  const texts: Text[] = [];
  (function collect(v: unknown) {
    if (Array.isArray(v)) { v.forEach(collect); return; }
    if (v !== null && typeof v === 'object') {
      const keys = Object.keys(v);
      if (keys.length === 2 && 'en' in v && 'id' in v) { texts.push(v as Text); return; }
      Object.values(v).forEach(collect);
    }
  })(SILENT_FRIDAY);

  it('names only pictures, portraits, tracks and cast that exist', () => {
    const art = join(pub, 'quest', SILENT_FRIDAY.art);
    for (const s of steps) {
      if ('bg' in s && s.bg) expect(existsSync(join(art, 'bg', `${s.bg}.webp`)), s.bg).toBe(true);
      if ('cg' in s && s.cg) {
        const sealed = s.cg.startsWith('sealed:');
        const file = sealed ? join(root, 'src/quest/silent-friday/sealed', `${s.cg.slice(7)}.webp`) : join(art, 'bg', `${s.cg}.webp`);
        expect(existsSync(file), s.cg).toBe(true);
        // A picture that gives an answer away is never public.
        if (sealed) expect(existsSync(join(art, 'bg', `${s.cg.slice(7)}.webp`)), s.cg).toBe(false);
      }
      if ('music' in s && s.music) expect(existsSync(join(art, 'music', `${s.music}.mp3`)), s.music).toBe(true);
      if ('say' in s) expect(SILENT_FRIDAY.cast[s.say], s.say).toBeDefined();
      if ('show' in s) expect(SILENT_FRIDAY.cast[s.show]?.art, s.show).toBeDefined();
      if ('intro' in s) expect(SILENT_FRIDAY.cast[s.intro.who]?.art, s.intro.who).toBeDefined();
      if ('hide' in s && s.hide !== 'all') expect(SILENT_FRIDAY.cast[s.hide], s.hide).toBeDefined();
    }
    for (const c of SILENT_FRIDAY.chapters) expect(existsSync(join(art, 'bg', `${c.cover}.webp`)), c.cover).toBe(true);
    for (const m of Object.values(SILENT_FRIDAY.cast)) {
      for (const src of Object.values(m.art ?? {})) expect(existsSync(join(pub, src.replace(/^\/static\//, ''))), src).toBe(true);
    }
    for (const c of SILENT_FRIDAY.chapters) {
      for (const e of c.challenge?.evidence ?? []) expect(existsSync(join(root, 'src/quest/silent-friday/evidence', e.file))).toBe(true);
      for (const f of c.challenge?.drop?.files ?? []) expect(existsSync(join(root, 'src/quest/silent-friday/evidence', f.file))).toBe(true);
    }
  });

  it('plays only effects the stage knows', () => {
    const js = readFileSync(join(pub, 'quest.js'), 'utf8') + readFileSync(join(pub, 'ui.js'), 'utf8');
    for (const s of steps) if ('sfx' in s) expect(js, s.sfx).toMatch(new RegExp(`\\b${s.sfx}: function`));
  });

  it('every line is written in both languages', () => {
    expect(texts.length).toBeGreaterThan(150);
    for (const t of texts) {
      expect(t.en.trim(), JSON.stringify(t)).not.toBe('');
      expect(t.id.trim(), JSON.stringify(t)).not.toBe('');
    }
  });

  it('every case chapter has an answer, and every answer is already normalised', () => {
    for (const c of SILENT_FRIDAY.chapters) {
      if (!c.challenge) continue;
      expect(c.challenge.answers.length).toBeGreaterThan(0);
      for (const a of c.challenge.answers) expect(normalise(a)).toBe(a);
      expect(c.post?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
