import { describe, it, expect } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { COOKIE_OPTIONS, preference } from '../src/core/cookies.js';
import { setCookieHeader } from './helpers.js';

const isColor = (x: unknown): x is 'red' | 'blue' => x === 'red' || x === 'blue';

function app() {
  const a = express();
  a.use(cookieParser());
  a.get('/', (req, res) => {
    res.json({ color: preference(req, res, { query: 'color', cookie: 'pref_color', isValid: isColor, fallback: 'red' }) });
  });
  return a;
}

describe('cookie policy', () => {
  it('COOKIE_OPTIONS is a frozen one-year, httpOnly, SameSite=Lax, path=/ policy', () => {
    expect(COOKIE_OPTIONS).toEqual({
      httpOnly: true, sameSite: 'lax', path: '/', maxAge: 365 * 24 * 60 * 60 * 1000,
    });
    expect(Object.isFrozen(COOKIE_OPTIONS)).toBe(true);
  });
});

describe('preference(): query → cookie → fallback', () => {
  it('uses the fallback with nothing set', async () => {
    const res = await request(app()).get('/');
    expect(res.body.color).toBe('red');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('a valid query wins and is persisted', async () => {
    const res = await request(app()).get('/?color=blue');
    expect(res.body.color).toBe('blue');
    expect(setCookieHeader(res, 'pref_color')).toMatch(/^pref_color=blue; Max-Age=31536000/);
  });

  it('a valid query equal to the cookie writes nothing', async () => {
    const res = await request(app()).get('/?color=blue').set('Cookie', 'pref_color=blue');
    expect(res.body.color).toBe('blue');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('an invalid query falls back to a valid cookie, then to the fallback', async () => {
    expect((await request(app()).get('/?color=green').set('Cookie', 'pref_color=blue')).body.color).toBe('blue');
    expect((await request(app()).get('/?color=green').set('Cookie', 'pref_color=pink')).body.color).toBe('red');
  });
});
