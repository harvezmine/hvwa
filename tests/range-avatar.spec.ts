// "Choose your avatar" (src/range/avatar.ts): the roster, the first-visit invitation, saving, skipping, and the hero's
// portrait on the licence, the account button and the leaderboard.
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { csrfOf } from './helpers.js';
import { player, portalApp } from './support/range.js';
import { DEFAULT_AVATAR, HEROES, parseAvatar } from '../src/range/avatar.js';

const art = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'public', 'art', 'heroes');

describe('the roster', () => {
  it('has at least eight heroes, each with its portrait and face on disk', () => {
    expect(HEROES.length).toBeGreaterThanOrEqual(8);
    expect(new Set(HEROES.map((h) => h.id)).size).toBe(HEROES.length);
    for (const h of HEROES) {
      expect(existsSync(join(art, `${h.id}.webp`)), h.id).toBe(true);
      expect(existsSync(join(art, `${h.id}-face.webp`)), h.id).toBe(true);
    }
  });

  it('accepts only a hero on the roster', () => {
    expect(parseAvatar({ hero: 'lyra' })).toBe('lyra');
    expect(parseAvatar({ hero: 'mira' })).toBeUndefined();
    expect(parseAvatar({ hero: '../../etc/passwd' })).toBeUndefined();
    expect(parseAvatar({})).toBeUndefined();
    expect(parseAvatar(undefined)).toBeUndefined();
  });
});

describe('choosing an avatar', () => {
  it('invites a new player, saves the hero and draws it on the licence, the account button and the leaderboard', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'alice');
    const hall = (await agent.get('/')).text;
    expect(hall).toContain('data-testid="preboard"');
    expect(hall).toContain('data-testid="reception-create"');
    expect(hall).toContain(`/static/art/heroes/${DEFAULT_AVATAR.hero}-face.webp`);

    const page = await agent.get('/adventurer');
    expect(page.status).toBe(200);
    expect(page.text).toContain('data-testid="avatar-skip"');
    for (const h of HEROES) expect(page.text, h.id).toContain(`data-testid="hero-${h.id}"`);
    const saved = await agent.post('/adventurer').type('form').send({ _csrf: csrfOf(page.text), hero: 'morrigan' });
    expect(saved.status).toBe(303);
    expect(saved.headers.location).toBe('/?made=1');

    const after = (await agent.get('/?made=1')).text;
    expect(after).not.toContain('data-testid="preboard"');
    expect(after).toMatch(/class="avatar av-lg" data-hero="morrigan" data-color="amethyst"/);
    expect(after).toMatch(/class="avatar av-sm" data-hero="morrigan"/); // the account button
    expect((await agent.get('/adventurer')).text).not.toContain('data-testid="avatar-skip"');
    expect((await agent.get('/leaderboard')).text).toContain('/static/art/heroes/morrigan-face.webp');
  });

  it('refuses a hero outside the roster and a form without the token', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'alice');
    const page = (await agent.get('/adventurer')).text;
    const bad = await agent.post('/adventurer').type('form').send({ _csrf: csrfOf(page), hero: 'dragon' });
    expect(bad.status).toBe(303);
    expect(bad.headers.location).toBe('/adventurer');
    const forged = await agent.post('/adventurer').type('form').send({ hero: 'lyra' });
    expect(forged.status).toBe(403);
    expect((await agent.get('/')).text).toContain('data-testid="preboard"');
  });

  it('a skip keeps the default adventurer and never overwrites one already chosen', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'alice');
    const skip = await agent.post('/adventurer/skip').type('form').send({ _csrf: csrfOf((await agent.get('/')).text) });
    expect(skip.status).toBe(303);
    const hall = (await agent.get('/')).text;
    expect(hall).not.toContain('data-testid="preboard"');
    expect(hall).toContain(`data-hero="${DEFAULT_AVATAR.hero}"`);

    const page = (await agent.get('/adventurer')).text;
    await agent.post('/adventurer').type('form').send({ _csrf: csrfOf(page), hero: 'corin' });
    await agent.post('/adventurer/skip').type('form').send({ _csrf: csrfOf((await agent.get('/')).text) });
    expect((await agent.get('/')).text).toContain('data-hero="corin"');
  });
});
