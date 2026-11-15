import { describe, it, expect } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { levelMiddleware } from '../src/core/difficulty.js';
import { langMiddleware } from '../src/core/i18n.js';

function app() {
  const a = express();
  a.use(cookieParser());
  a.use(levelMiddleware());
  a.use(langMiddleware());
  a.get('/probe', (req, res) => res.json({
    level: (req as any).level, lang: res.locals.lang, nav: res.locals.t('nav.districts'),
  }));
  return a;
}

const cookieFor = (res: request.Response, name: string) =>
  ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? []).find((c) => c.startsWith(`${name}=`));

describe('level preference', () => {
  it('defaults to acolyte with no query and no cookie', async () => {
    const res = await request(app()).get('/probe');
    expect(res.body.level).toBe('acolyte');
    expect(cookieFor(res, 'hvwa_level')).toBeUndefined();
  });

  it('a valid ?level= wins and is persisted in an httpOnly, SameSite=Lax cookie', async () => {
    const agent = request.agent(app());
    const r1 = await agent.get('/probe?level=templar');
    expect(r1.body.level).toBe('templar');
    expect(cookieFor(r1, 'hvwa_level')).toMatch(/hvwa_level=templar;.*HttpOnly/i);
    expect(cookieFor(r1, 'hvwa_level')).toMatch(/SameSite=Lax/i);
    const r2 = await agent.get('/probe'); // query → cookie → acolyte
    expect(r2.body.level).toBe('templar');
  });

  it('an invalid ?level= falls back to the cookie and does not overwrite it', async () => {
    const res = await request(app()).get('/probe?level=godmode').set('Cookie', 'hvwa_level=inquisitor');
    expect(res.body.level).toBe('inquisitor');
    expect(cookieFor(res, 'hvwa_level')).toBeUndefined();
  });

  it('an invalid cookie falls back to acolyte', async () => {
    const res = await request(app()).get('/probe').set('Cookie', 'hvwa_level=root');
    expect(res.body.level).toBe('acolyte');
  });
});

describe('lang preference', () => {
  it('defaults to id', async () => {
    const res = await request(app()).get('/probe');
    expect(res.body).toMatchObject({ lang: 'id', nav: 'Distrik' });
  });

  it('a valid ?lang= is used, persisted in an httpOnly cookie, and remembered', async () => {
    const agent = request.agent(app());
    const r1 = await agent.get('/probe?lang=en');
    expect(r1.body).toMatchObject({ lang: 'en', nav: 'Districts' });
    expect(cookieFor(r1, 'hvwa_lang')).toMatch(/hvwa_lang=en;.*HttpOnly/i);
    expect(cookieFor(r1, 'hvwa_lang')).toMatch(/SameSite=Lax/i);
    const r2 = await agent.get('/probe');
    expect(r2.body.lang).toBe('en');
  });

  it('an invalid ?lang= falls back to the cookie', async () => {
    const res = await request(app()).get('/probe?lang=fr').set('Cookie', 'hvwa_lang=en');
    expect(res.body.lang).toBe('en');
    expect(cookieFor(res, 'hvwa_lang')).toBeUndefined();
  });
});
