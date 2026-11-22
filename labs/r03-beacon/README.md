# Beacon (r03) — OS command injection (Medium)

Beacon is a home-router admin panel with the feel of a real network appliance: a dark dashboard, WAN/LAN and Wi-Fi
views, DHCP leases, a firewall table, a syslog, a firmware changelog and a connectivity diagnostics console. Its
diagnostics tool probes a host the operator types by running a real busybox shell. The flag is a file
(`/tmp/beacon/flag.txt`, in the tmpfs because the rootfs is read-only): at start the app reads the one-shot flag file
(`HVWA_FLAG_FILE`, default `/tmp/.hvwa-flag`), unlinks it, then writes it there. The flag is never in the environment.
No page renders the file; only a shell reading it does.

At Inquisitor the obvious host injection is closed, so the lab becomes a two-step chain: the host is validated and the
probe runs no shell, but the free-text label an operator saves is later trusted by the report generator and reaches a
shell. Acolyte/Templar keep the original single-request host injection unchanged.

## Pages

| Route | What it shows |
| --- | --- |
| `/` | Dashboard: device model/serial/firmware, uptime and last boot, WAN/LAN LEDs, client count, CPU/RAM/temperature gauges, CSS sparklines, and a simulated (CSS-only) reboot. |
| `/network` | WAN uplink, LAN bridge, interfaces, DHCP leases, firewall rules and connected clients. |
| `/wifi` | SSID, WPA3 security, per-band channel/width/utilisation and associated wireless clients. |
| `/diagnostics` | **The vulnerable feature.** Host probe, presets, terminal-style output, and a per-process recent-probe list. At Inquisitor/Divine it also accepts a free-text label. |
| `/diagnostics/report` | **The second-order sink (unlinked).** Runs the report generator over the most recent saved label and renders the report file. Divine renders the escaped label only, with no execution. |
| `/logs` | Seed-driven syslog with severity chips, plus probe entries held in memory for this process. |
| `/firmware` | Installed build, update channel and release changelog. |
| `/system` | CPU/memory/temperature, load, fan, storage, services and admin sessions. |
| `/status` | Human-readable device summary, interface table, DNS/routes and clients (replaces the old raw key/value dump). |

All content is served from `seed/device.json` and rendered inline (SVG and CSS only; no external assets, fonts or
CDNs). Every reflected value — probe host, client names, log lines, probe history — is HTML-escaped. The UI is
responsive down to 375 px and honours `prefers-reduced-motion`. The app uses the Node standard library only.

## Vulnerable feature

There are exactly two shell sinks, both confined to the diagnostics feature:

1. `POST /diagnostics` (Acolyte/Templar) — the connectivity probe. The shell string is `echo "Diagnostics for <host>";
   ping -c 1 -W 1 <host> 2>&1 || true`; the echoed line makes exfiltration deterministic without `CAP_NET_RAW` (the
   ping is cosmetic). At Inquisitor/Divine the host is instead validated against a strict hostname/IP pattern and
   `execFile('ping', [...])` runs with an argument array (no shell).
2. `GET /diagnostics/report` (Inquisitor) — the report generator. It takes the **most recent saved label** (saved by
   `POST /diagnostics`) and runs `sh -c 'echo "<label>" >> /tmp/beacon/report.txt'`, then renders the report file. The
   label is trusted, so command substitution in it runs a second command after the host validation has already passed:
   a second-order injection. At Divine the label is rendered escaped and never executed.

The diagnostics page stores the host and label in memory and appends them to `/tmp/beacon/probes.log`; the recent-probe
list renders both escaped. It never stores probe output and never the flag file. Every other page is read-only seed
rendering. The report route is not linked from any page (the reference solve calls it directly).

## Levels

- **Acolyte.** `<host>` is concatenated straight into `sh -c`. End the command and read the flag file.
- **Templar.** The tool rejects `; & | ` backtick and newline, then still concatenates. The Acolyte separator is
  blocked, so it fails. Command substitution contains none of those; its output lands in the echoed status line.
- **Inquisitor.** The host is validated strictly and probed without a shell, so the host tricks above fail. The probe
  also saves a free-text label; the report generator trusts it and interpolates it into `sh -c 'echo "<label>" >> …'`.
  Saving `$(cat /tmp/beacon/flag.txt)` as the label and then opening the report substitutes the flag into the file.
- **Divine.** No shell for the probe (validated `execFile('ping', …)`) and no shell for the report (it renders the
  escaped label only). The page reports host rejections clearly (with the Indonesian line beneath the English one).
  Nothing can chain or substitute a command. No flag.

Note: `ping` may lack `CAP_NET_RAW` under the range hardening and fail; that is intentional and irrelevant — the flaw
and the flag path run through `echo`/the shell, not through a successful ping.

## Reference solves

`solve/acolyte.mjs`, `solve/templar.mjs` and `solve/inquisitor.mjs` are HTTP clients; each contains the intended input
for its level (Inquisitor performs the two-step chain: save the label, then request the report).
`npm run labs:test -- --lab r03` proves each works at its level, that every lower-level solve fails at every higher
level, that the Inquisitor chain fails at Divine and that Divine resists everyone.
