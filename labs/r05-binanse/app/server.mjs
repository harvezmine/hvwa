// labs/r05-binanse/app/server.mjs — Binanse, a fictional crypto exchange. Stored-XSS chain, Inquisitor only:
//   1. a logged-in user stores a support-ticket body raw; the user's own view escapes it;
//   2. "Request staff review" runs the body in the simulated DevOps browser (bot.mjs), whose localStorage holds
//      the DevOps access token (bn_staff_token) and which can fetch the app as the engineer;
//   3. the payload posts that token to the public attacker inbox, readable at /attacker;
//   4. the stolen token signs the player in at /staff/login (HttpOnly bn_staff cookie) → console → settings PIN →
//      whitelist the player's own wallet → transfer the whole vault balance → the receipt reveals the flag.
// The flag is read once from HVWA_FLAG_FILE, unlinked, held in memory, and rendered only in that receipt. Never logged.
// Node standard library only; all state is in memory. Listens on 0.0.0.0:$HVWA_PORT.
import { createServer } from 'node:http';
import { readFileSync, unlinkSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { simulateStaffBrowser } from './bot.mjs';
import {
  landingPage, registerPage, loginPage, dashboardPage, ticketsPage, ticketDetailPage, attackerPage,
  staffLoginPage, staffConsolePage, staffSettingsPage, staffWhitelistPage, staffTransferPage,
  receiptPage, notFoundPage, serverErrorPage,
} from './render.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.HVWA_PORT || 8080);
const flagSource = process.env.HVWA_FLAG_FILE || '/tmp/.hvwa-flag';
const BASE_URL = `http://127.0.0.1:${port}`;

/** Poll for the one-shot flag file, read it once and unlink it. Never log its value. */
async function readFlag() {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const value = readFileSync(flagSource, 'utf8').trim();
      if (value) { unlinkSync(flagSource); return value; }
    } catch { /* the warden has not written it yet */ }
    if (Date.now() >= deadline) {
      console.error('binanse: the flag file never appeared');
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const flag = await readFlag();

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const WALLET_RE = /^bn1[a-z2-7]{40}$/;
const MAX_SESSIONS = 256;

function walletAddress() {
  const bytes = randomBytes(40);
  let s = 'bn1';
  for (let i = 0; i < 40; i++) s += B32[bytes[i] % 32];
  return s;
}

/** An unbiased 6-digit withdrawal PIN from crypto randomness. */
function sixDigitPin() {
  let n;
  do { n = randomBytes(4).readUInt32BE(0); } while (n >= 4_000_000_000);
  return String(n % 1_000_000).padStart(6, '0');
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 32).toString('hex');
}
function verifyPassword(password, salt, expectedHex) {
  const actual = scryptSync(password, salt, 32);
  const want = Buffer.from(expectedHex, 'hex');
  return actual.length === want.length && timingSafeEqual(actual, want);
}

// --- in-memory state ------------------------------------------------------------------------------------------------
const market = JSON.parse(readFileSync(join(here, 'seed', 'market.json'), 'utf8'));
const users = new Map();          // username -> { username, salt, hash, wallet, balances, createdAt }
const byWallet = new Map();       // wallet -> username
const sessions = new Map();       // bn_sid token -> username
const staffToken = randomBytes(24).toString('base64url'); // held in the bot's localStorage and the staff cookie
const pin = sixDigitPin();                                 // withdrawal PIN, shown only on /staff/settings
const whitelist = new Set();
const vault = { balances: { BTC: 12.5, ETH: 480, USDT: 1_250_000 }, balance: 1_250_000, drained: false };
const tickets = new Map();        // id -> { id, owner, subject, body, reviewed, createdAt }
const inbox = [];                 // { id, body, at } — entries POSTed to /api/attacker/inbox
let ticketSeq = 0;
let inboxSeq = 0;

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

// --- small HTTP helpers ----------------------------------------------------------------------------------------------
const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const html = (res, status, body) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
const redirect = (res, location) => { res.writeHead(303, { location, 'cache-control': 'no-store' }); res.end(); };

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i >= 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function setCookie(res, name, value, { maxAge = 0 } = {}) {
  const tail = maxAge > 0 ? `; Max-Age=${maxAge}` : '';
  res.setHeader('set-cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${tail}`);
}
function clearCookie(res, name) {
  res.setHeader('set-cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function parseForm(body) {
  const out = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

function userFrom(req) {
  const token = cookies(req).bn_sid;
  return token ? sessions.get(token) : undefined;
}
function staffFrom(req) {
  return cookies(req).bn_staff === staffToken;
}

function openSession(res, username) {
  const token = randomBytes(24).toString('base64url');
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  sessions.set(token, username);
  setCookie(res, 'bn_sid', token, { maxAge: 60 * 60 * 8 });
}

// --- handlers ---------------------------------------------------------------------------------------------------------
async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://binanse');
  const p = url.pathname;
  const method = req.method ?? 'GET';

  if (p === '/healthz') return json(res, 200, { status: 'ok' });

  // --- public GET pages ---
  if (method === 'GET') {
    if (p === '/') return html(res, 200, landingPage(market));
    if (p === '/register') return html(res, 200, registerPage());
    if (p === '/login') return html(res, 200, loginPage());
    if (p === '/logout') { const u = userFrom(req); if (u) sessions.delete(cookies(req).bn_sid); clearCookie(res, 'bn_sid'); return redirect(res, '/'); }
    if (p === '/staff/login') return html(res, 200, staffLoginPage());
    if (p === '/staff/logout') { clearCookie(res, 'bn_staff'); return redirect(res, '/staff/login'); }
  }

  // --- public API: the attacker inbox (the exfiltration target) ---
  if (p === '/api/attacker/inbox' && method === 'POST') {
    let body;
    try { body = await readBody(req, 4096); } catch { return json(res, 413, { error: 'too large' }); }
    if (body.length > 4096) return json(res, 413, { error: 'too large' });
    inbox.push({ id: ++inboxSeq, body, at: now() });
    return json(res, 200, { ok: true });
  }

  // --- account registration / login ---
  if (p === '/register' && method === 'POST') {
    const form = parseForm(await readBody(req));
    const username = String(form.username ?? '').trim();
    const password = String(form.password ?? '');
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) return html(res, 400, registerPage('Username must be 3–32 letters, numbers, _ or -.'));
    if (password.length < 8 || password.length > 128) return html(res, 400, registerPage('Password must be 8–128 characters.'));
    if (users.has(username)) return html(res, 409, registerPage('That username is already taken.'));
    const salt = randomBytes(16).toString('hex');
    const wallet = walletAddress();
    const record = {
      username, salt, hash: hashPassword(password, salt), wallet,
      balances: { BTC: 0.05, ETH: 1.2, USDT: 500 },
      createdAt: now(),
    };
    users.set(username, record);
    byWallet.set(wallet, username);
    openSession(res, username);
    return redirect(res, '/dashboard');
  }
  if (p === '/login' && method === 'POST') {
    const form = parseForm(await readBody(req));
    const username = String(form.username ?? '').trim();
    const password = String(form.password ?? '');
    const record = users.get(username);
    if (!record || !verifyPassword(password, record.salt, record.hash)) {
      return html(res, 401, loginPage('Invalid username or password.'));
    }
    openSession(res, username);
    return redirect(res, '/dashboard');
  }

  // --- signed-in user pages ---
  const username = userFrom(req);
  if (p === '/dashboard' && method === 'GET') {
    if (!username) return redirect(res, '/login');
    return html(res, 200, dashboardPage(users.get(username)));
  }
  if (p === '/tickets' && method === 'GET') {
    if (!username) return redirect(res, '/login');
    const mine = [...tickets.values()].filter((t) => t.owner === username);
    return html(res, 200, ticketsPage(mine));
  }
  const mTicket = p.match(/^\/tickets\/(\d+)$/);
  if (mTicket && method === 'GET') {
    if (!username) return redirect(res, '/login');
    const ticket = tickets.get(Number(mTicket[1]));
    if (!ticket || ticket.owner !== username) return html(res, 404, notFoundPage());
    return html(res, 200, ticketDetailPage(ticket));
  }
  if (p === '/attacker' && method === 'GET') {
    if (!username) return redirect(res, '/login');
    return html(res, 200, attackerPage(inbox));
  }

  // --- ticket creation + staff review ---
  if (p === '/tickets' && method === 'POST') {
    if (!username) return redirect(res, '/login');
    const form = parseForm(await readBody(req));
    const subject = String(form.subject ?? '').trim().slice(0, 120);
    const body = String(form.body ?? '').slice(0, 8192);
    if (!subject || !body) return redirect(res, '/tickets');
    const id = ++ticketSeq;
    tickets.set(id, { id, owner: username, subject, body, reviewed: false, createdAt: now() });
    return redirect(res, `/tickets/${id}`);
  }
  const mReview = p.match(/^\/tickets\/(\d+)\/review$/);
  if (mReview && method === 'POST') {
    if (!username) return redirect(res, '/login');
    const ticket = tickets.get(Number(mReview[1]));
    if (!ticket || ticket.owner !== username) return html(res, 404, notFoundPage());
    await simulateStaffBrowser(ticket.body, { baseUrl: BASE_URL, staffToken });
    ticket.reviewed = true;
    return redirect(res, `/tickets/${ticket.id}`);
  }

  // --- staff login ---
  if (p === '/staff/login' && method === 'POST') {
    const body = await readBody(req, 8192);
    const ct = String(req.headers['content-type'] ?? '');
    let token = '';
    if (ct.includes('json')) {
      try { token = String(JSON.parse(body).token ?? ''); } catch { token = ''; }
    } else if (ct.includes('x-www-form-urlencoded')) {
      token = String(parseForm(body).token ?? '').trim();
    } else {
      token = body.trim();
    }
    if (token !== staffToken) return html(res, 401, staffLoginPage('Invalid DevOps access token.'));
    setCookie(res, 'bn_staff', staffToken, { maxAge: 60 * 60 * 8 });
    return redirect(res, '/staff');
  }

  // --- staff console (requires bn_staff) ---
  if (p === '/staff' && method === 'GET') {
    if (!staffFrom(req)) return redirect(res, '/staff/login');
    return html(res, 200, staffConsolePage(vault, whitelist.size));
  }
  if (p === '/staff/settings' && method === 'GET') {
    if (!staffFrom(req)) return redirect(res, '/staff/login');
    return html(res, 200, staffSettingsPage(pin));
  }
  if (p === '/staff/whitelist' && method === 'GET') {
    if (!staffFrom(req)) return redirect(res, '/staff/login');
    const notice = { added: 'Address whitelisted.', bad: 'Address must look like bn1 + 40 letters/digits.', exists: 'That address is already whitelisted.' }[url.searchParams.get('msg') ?? ''];
    return html(res, 200, staffWhitelistPage([...whitelist], notice));
  }
  if (p === '/staff/transfer' && method === 'GET') {
    if (!staffFrom(req)) return redirect(res, '/staff/login');
    const notice = {
      addr: 'Destination is not whitelisted — add it first.',
      pin: 'Incorrect withdrawal PIN.',
      amount: 'Amount must equal the whole vault balance.',
      drained: 'The vault is already empty.',
      bad: 'Invalid request.',
    }[url.searchParams.get('msg') ?? ''];
    return html(res, 200, staffTransferPage(vault, notice));
  }

  if (p === '/staff/whitelist' && method === 'POST') {
    if (!staffFrom(req)) return redirect(res, '/staff/login');
    const form = parseForm(await readBody(req));
    const address = String(form.address ?? '').trim();
    if (!WALLET_RE.test(address)) return redirect(res, '/staff/whitelist?msg=bad');
    if (whitelist.has(address)) return redirect(res, '/staff/whitelist?msg=exists');
    whitelist.add(address);
    return redirect(res, '/staff/whitelist?msg=added');
  }

  if (p === '/staff/transfer' && method === 'POST') {
    if (!staffFrom(req)) return redirect(res, '/staff/login');
    const form = parseForm(await readBody(req));
    const address = String(form.address ?? '').trim();
    const pinInput = String(form.pin ?? '').trim();
    const amount = Number(String(form.amount ?? '').trim());
    if (!whitelist.has(address)) return redirect(res, '/staff/transfer?msg=addr');
    if (pinInput !== pin) return redirect(res, '/staff/transfer?msg=pin');
    if (!Number.isFinite(amount) || amount <= 0) return redirect(res, '/staff/transfer?msg=bad');
    if (vault.drained) return redirect(res, '/staff/transfer?msg=drained');
    if (Math.abs(amount - vault.balance) > 0.005) return redirect(res, '/staff/transfer?msg=amount');

    // The whole vault balance leaves; the destination wallet is credited; the receipt reveals the flag.
    const moved = vault.balance;
    vault.balances = { BTC: 0, ETH: 0, USDT: 0 };
    vault.balance = 0;
    vault.drained = true;
    const owner = byWallet.get(address);
    if (owner && users.has(owner)) users.get(owner).balances.USDT += moved;
    return html(res, 200, receiptPage(flag, { address, amount: moved }));
  }

  return html(res, 404, notFoundPage());
}

createServer((req, res) => {
  handle(req, res).catch(() => {
    // Never echo exception details (they can include request data). The flag is never in a message anyway.
    console.error('binanse: request failed');
    try {
      if (!res.headersSent) html(res, 500, serverErrorPage());
      else res.destroy();
    } catch { /* the socket is already gone */ }
  });
}).listen(port, '0.0.0.0', () => console.log(`binanse on :${port}`));
