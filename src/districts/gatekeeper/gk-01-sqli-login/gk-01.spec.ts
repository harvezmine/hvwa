// src/districts/gatekeeper/gk-01-sqli-login/gk-01.spec.ts
import { describe, it, expect } from 'vitest';
import { freshSession, describeExploitMatrix, FLAG_RE, DB_ERROR_RE, type Agent } from '../../../../tests/helpers.js';
import { LEVELS } from '../../../core/levels.js';
import { GK01 } from './challenge.js'; // registers GK-01 before createApp() inside freshSession
import { adminPassword } from './model.js';

const LAB = '/d/gatekeeper/sqli-login';
interface Creds { username: string; password: string }
const login = (agent: Agent, level: string, creds: Creds) =>
  agent.post(`${LAB}?level=${level}`).type('form').send(creds);

describeExploitMatrix<Creds>({
  challenge: GK01,
  path: LAB,
  send: (agent, _level, creds, url) => agent.post(url).type('form').send(creds),
  exploits: {
    acolyte: { username: "citadel_admin' --", password: 'x' },            // comment out the password check
    templar: { username: 'citadel_admin', password: "' OR role = 'admin" }, // quotes stripped from username only
    inquisitor: { username: 'citadel_admin', password: '%' },              // LIKE wildcard
  },
  resisted: 'Invalid credentials.',
  legit: [
    {
      name: 'own account pilgrim/pilgrim',
      input: { username: 'pilgrim', password: 'pilgrim' },
      expect: 'Welcome, pilgrim (role: user). Only the citadel admin holds the flag.',
    },
    { name: 'wrong admin password', input: { username: 'citadel_admin', password: 'definitely-wrong' }, expect: 'Invalid credentials.' },
  ],
  malformed: [
    // Inquisitor and Divine are parameterized: a quote cannot break their SQL.
    { name: 'lone quote in the password', input: { username: 'pilgrim', password: "'" }, levels: ['acolyte', 'templar'] },
  ],
  privileged: {
    name: 'citadel_admin with the real Divine password',
    input: { username: 'citadel_admin', password: adminPassword('divine') },
    expect: /Welcome, citadel_admin \(role: admin\)\.\s*</,
  },
});

describe('GK-01 per-level isolation', () => {
  it('every level has its own random admin password', () => {
    const pw = LEVELS.map((l) => adminPassword(l));
    for (const p of pw) expect(p).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(pw).size).toBe(LEVELS.length);
    expect(adminPassword('templar')).toBe(adminPassword('templar')); // stable per level
  });

  it('a password extracted with Acolyte SQLi earns the Acolyte flag but logs in nowhere else', async () => {
    const { agent } = await freshSession();
    const union = "' UNION SELECT password, role FROM users WHERE username = 'citadel_admin' --";
    const dump = (await login(agent, 'acolyte', { username: union, password: 'x' })).text;
    const stolen = /Welcome, ([0-9a-f]{32}) \(role: admin\)/.exec(dump)?.[1];
    expect(stolen, 'UNION extraction at acolyte').toBe(adminPassword('acolyte'));

    // Real credentials obtained from this level's own data still earn this level's flag.
    const own = (await login(agent, 'acolyte', { username: 'citadel_admin', password: stolen! })).text;
    expect(own).toContain('Welcome, citadel_admin (role: admin).');
    const flag = FLAG_RE.exec(own)?.[0];
    const submit = await agent.post('/api/submit').send({ challengeId: 'GK-01', submission: flag });
    expect(submit.body).toMatchObject({ solved: true, level: 'acolyte' });

    for (const level of ['templar', 'inquisitor', 'divine'] as const) {
      const text = (await login(agent, level, { username: 'citadel_admin', password: stolen! })).text;
      expect(text, level).toContain('Invalid credentials.');
      expect(text, level).not.toMatch(FLAG_RE);
    }
  });
});

describe('GK-01 lab view', () => {
  const formTag = (html: string) => /<form[^>]*>/.exec(html)?.[0] ?? '';
  const inputs = (html: string) => [...html.matchAll(/<input[^>]*>/g)].map((m) => m[0]);

  it('tells the player their own account, shows typed payloads, and posts back to the lab', async () => {
    const { agent } = await freshSession();
    const res = await agent.get(`${LAB}?level=acolyte`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/pilgrim[\s\S]{0,40}\/[\s\S]{0,40}pilgrim/);
    expect(res.text).toContain('name="username"');
    expect(res.text).toContain('name="password"');
    expect(res.text).not.toMatch(/type="password"/);
    expect(formTag(res.text)).toMatch(/method="post"/);
    expect(formTag(res.text)).not.toContain('action');
  });

  it('keeps the submitted values after POST, escaped', async () => {
    const { agent } = await freshSession();
    const username = '"><script>alert(1)</script>';
    const password = "<b>'%";
    const res = await login(agent, 'inquisitor', { username, password });
    const [u, p] = inputs(res.text);
    expect(u).toContain('value="&#34;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(p).toContain('value="&lt;b&gt;&#39;%"');
    expect(res.text).not.toContain('<script>alert(1)');
  });

  it('escapes a row forged by injection in the welcome message', async () => {
    const { agent } = await freshSession();
    const forged = "' UNION SELECT '<img src=x onerror=alert(1)>', 'user' --";
    const res = await login(agent, 'acolyte', { username: forged, password: 'x' });
    expect(res.text).toContain('Welcome, &lt;img src=x onerror=alert(1)&gt; (role: user). Only the citadel admin holds the flag.');
    expect(res.text).not.toContain('<img src=x');
  });

  it('marks success and failure messages for styling', async () => {
    const { agent } = await freshSession();
    const ok = await login(agent, 'templar', { username: 'pilgrim', password: 'pilgrim' });
    expect(ok.text).toMatch(/class="lab-message lab-success"[^>]*>Welcome, pilgrim/);
    const bad = await login(agent, 'templar', { username: 'pilgrim', password: 'nope' });
    expect(bad.text).toMatch(/class="lab-message lab-error"[^>]*>Invalid credentials\./);
    const err = await login(agent, 'templar', { username: 'pilgrim', password: "'" });
    expect(err.text).toMatch(/class="lab-message lab-error"[^>]*>Database error: /);
  });

  it('non-string fields (JSON objects, extended-urlencoded nesting) are a failed login, not a 500', async () => {
    const { agent } = await freshSession();
    for (const level of LEVELS) {
      const json = await agent.post(`${LAB}?level=${level}`).send({ username: { toString: 1 }, password: ['a'] });
      expect(json.status, level).toBe(200);
      expect(json.text, level).toContain('Invalid credentials.');
      const nested = await agent.post(`${LAB}?level=${level}`).type('form').send('username[toString]=1&password=x');
      expect(nested.status, level).toBe(200);
      expect(nested.text, level).not.toMatch(DB_ERROR_RE);
    }
  });

  it('names the target citadel_admin (not a level name) on the lab and challenge pages', async () => {
    const { agent } = await freshSession();
    for (const p of [`${LAB}?lang=en`, `${LAB}?lang=id`, '/c/GK-01']) {
      const html = (await agent.get(p)).text;
      expect(html, p).toContain('citadel_admin');
      expect(html, p).not.toContain('templar_admin');
    }
  });
});
