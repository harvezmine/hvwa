# Beacon (r03) — OS command injection (Medium)

Beacon is a home-router admin panel. Its diagnostics tool probes a host the operator types by running a real busybox
shell. The flag is a file (`/tmp/beacon/flag.txt`, in the tmpfs because the rootfs is read-only), written at start from
`HVWA_FLAG` and then scrubbed from the environment. No page renders the file; only a shell reading it does.

## Vulnerable feature
`POST /diagnostics` — the connectivity probe. The shell string is `echo "Diagnostics for <host>"; ping -c 1 -W 1
<host> 2>&1 || true`; the echoed line makes exfiltration deterministic without `CAP_NET_RAW` (the ping is cosmetic).

## Levels
- **Acolyte.** `<host>` is concatenated straight into `sh -c`. End the command and read the flag file.
- **Templar.** The tool rejects `; & | ` backtick and newline, then still concatenates. The Acolyte separator is
  blocked, so it fails. Command substitution contains none of those; its output lands in the echoed status line.
- **Divine.** No shell: `execFile('ping', ['-c','1','-W','1', host])` with an argument array, and `host` is validated
  against a strict hostname/IP pattern first. Nothing can chain or substitute a command. No flag.

Note: `ping` may lack `CAP_NET_RAW` under the range hardening and fail; that is intentional and irrelevant — the flaw
and the flag path run through `echo`/the shell, not through a successful ping.

## Reference solves
`solve/acolyte.mjs` and `solve/templar.mjs` are HTTP clients; the reference solve contains the intended shell input for
each level. `npm run labs:test -- --lab r03` proves each works at its level and that the Acolyte input fails at Templar
and Divine.
