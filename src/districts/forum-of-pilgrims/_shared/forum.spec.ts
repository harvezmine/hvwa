// src/districts/forum-of-pilgrims/_shared/forum.spec.ts — the forum shell's pure plumbing.
import { describe, it, expect } from 'vitest';
import { PLAYER, THREADS, forumLogin, threadById } from './forum.js';

describe('forumLogin', () => {
  it('takes anything with a body, such as a simulated browser\'s request (no Express Request needed)', () => {
    const sim = { body: { username: PLAYER.username, password: PLAYER.password } };
    expect(forumLogin(sim)).toMatchObject({ ok: true, username: 'pilgrim' });
    expect(forumLogin({ body: { username: 'pilgrim', password: 'no' } }).ok).toBe(false);
    expect(forumLogin({}).ok).toBe(false);
    expect(forumLogin({ body: { username: { a: 1 }, password: ['x'] } })).toMatchObject({ ok: false, username: '', password: '' });
  });
});

describe('threads', () => {
  it('are looked up by their numeric id string only', () => {
    expect(threadById('1')?.id).toBe(1);
    expect(THREADS.length).toBe(3);
    for (const id of ['', '0', '01', '1 ', '__proto__', 'constructor']) expect(threadById(id), id).toBeUndefined();
  });
});
