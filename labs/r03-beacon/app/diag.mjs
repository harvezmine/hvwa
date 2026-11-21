// labs/r03-beacon/app/diag.mjs — Beacon's connectivity probe, per level. The echoed status line makes the result
// deterministic without CAP_NET_RAW; the ping is cosmetic (|| true). acolyte/templar run a REAL shell (busybox sh -c);
// divine runs no shell at all.
import { execFile } from 'node:child_process';

// divine's strict allow-list: a dotted hostname or IPv4 address. Each label starts and ends alphanumeric (so a
// leading '-' such as `-f`/`--help` is rejected, as `execFile` would otherwise read it as a ping option), at most
// 63 chars per label and 253 overall.
const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const BLOCKED = /[;&|`\n\r]/;                                 // templar's naive blocklist (misses $() substitution)

/** Run the probe for `host` at `level`; resolves { output } (combined stdout+stderr) or { error }. */
export function probe(level, host) {
  return new Promise((resolve) => {
    if (level === 'divine') {
      if (!HOSTNAME_RE.test(host)) return resolve({ error: 'Enter a valid hostname or IP address.' });
      return execFile('ping', ['-c', '1', '-W', '1', host], { timeout: 4000 },
        (_err, stdout, stderr) => resolve({ output: `${stdout}${stderr}` || 'Probe finished.' }));
    }
    if (level === 'templar' && BLOCKED.test(host)) return resolve({ error: 'That host contains characters that are not allowed.' });
    // acolyte and templar: host is concatenated into a real shell command.
    const cmd = `echo "Diagnostics for ${host}"; ping -c 1 -W 1 ${host} 2>&1 || true`;
    execFile('/bin/sh', ['-c', cmd], { timeout: 4000 }, (_err, stdout, stderr) => resolve({ output: `${stdout}${stderr}` }));
  });
}
