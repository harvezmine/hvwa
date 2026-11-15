import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

describe('offline UI shell', () => {
  it('loads no external scripts or stylesheets', async () => {
    const res = await request(createApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/<script[^>]+src="(https?:)?\/\//i);
    expect(res.text).not.toMatch(/<link[^>]+href="(https?:)?\/\//i);
    expect(res.text).not.toContain('cdn.tailwindcss.com');
    expect(res.text).not.toContain('cdnjs');
  });

  it('links the local stylesheet and vendored htmx, with no inline <style>', async () => {
    const res = await request(createApp()).get('/');
    expect(res.text).toContain('<link rel="stylesheet" href="/static/app.css">');
    expect(res.text).toContain('<script src="/static/vendor/htmx.min.js"></script>');
    expect(res.text).not.toMatch(/<style[\s>]/i);
  });

  it('serves app.css locally', async () => {
    const res = await request(createApp()).get('/static/app.css');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/css/);
    expect(res.text).toContain('.diff-view');
  });

  it('app.css styles labs: lab bar, .lab, messages (mono, wrap anywhere) with success/error modifiers', async () => {
    const css = (await request(createApp()).get('/static/app.css')).text;
    for (const sel of ['.lab-bar', '.lab-levels', '.lab {', '.lab-message', '.lab-success', '.lab-error']) {
      expect(css, sel).toContain(sel);
    }
    const message = /\.lab-message\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(message).toContain('font-family: var(--mono)');
    expect(message).toContain('overflow-wrap: anywhere');
  });

  it('serves htmx 2.0.4 from node_modules at /static/vendor/htmx.min.js', async () => {
    const res = await request(createApp()).get('/static/vendor/htmx.min.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.text).toContain('2.0.4');
  });

  it('serves only htmx.min.js from the vendor path, not the rest of htmx dist/', async () => {
    const app = createApp();
    for (const p of ['htmx.js', 'htmx.esm.js', 'htmx.min.js.gz', 'htmx.esm.d.ts', 'ext/', '']) {
      const res = await request(app).get(`/static/vendor/${p}`);
      expect(res.status, `/static/vendor/${p}`).toBe(404);
    }
  });
});
