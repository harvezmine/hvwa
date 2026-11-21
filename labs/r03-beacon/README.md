# Beacon (r03) — OS command injection (Medium)

Beacon is a home-router admin panel with the feel of a real network appliance: a dark dashboard, WAN/LAN and Wi-Fi
views, DHCP leases, a firewall table, a syslog, a firmware changelog and a connectivity diagnostics console. Its
diagnostics tool probes a host the operator types by running a real busybox shell. The flag is a file
(`/tmp/beacon/flag.txt`, in the tmpfs because the rootfs is read-only): at start the app reads the one-shot flag file
(`HVWA_FLAG_FILE`, default `/tmp/.hvwa-flag`), unlinks it, then writes it there. The flag is never in the environment.
No page renders the file; only a shell reading it does.

## Pages

| Route | What it shows |
| --- | --- |
| `/` | Dashboard: device model/serial/firmware, uptime and last boot, WAN/LAN LEDs, client count, CPU/RAM/temperature gauges, CSS sparklines, and a simulated (CSS-only) reboot. |
| `/network` | WAN uplink, LAN bridge, interfaces, DHCP leases, firewall rules and connected clients. |
| `/wifi` | SSID, WPA3 security, per-band channel/width/utilisation and associated wireless clients. |
| `/diagnostics` | **The vulnerable feature.** Host probe, presets, terminal-style output, and a per-process recent-probe list. |
| `/logs` | Seed-driven syslog with severity chips, plus probe entries held in memory for this process. |
| `/firmware` | Installed build, update channel and release changelog. |
| `/system` | CPU/memory/temperature, load, fan, storage, services and admin sessions. |
| `/status` | Human-readable device summary, interface table, DNS/routes and clients (replaces the old raw key/value dump). |

All content is served from `seed/device.json` and rendered inline (SVG and CSS only; no external assets, fonts or
CDNs). Every reflected value — probe host, client names, log lines, probe history — is HTML-escaped. The UI is
responsive down to 375 px and honours `prefers-reduced-motion`. The app uses the Node standard library only.

## Vulnerable feature

`POST /diagnostics` — the connectivity probe. The shell string is `echo "Diagnostics for <host>"; ping -c 1 -W 1
<host> 2>&1 || true`; the echoed line makes exfiltration deterministic without `CAP_NET_RAW` (the ping is cosmetic).
This is the only place any page/field reaches a shell; every other page is read-only seed rendering. The recent-probe
list stores only the submitted host (never probe output, never the flag file).

## Levels

- **Acolyte.** `<host>` is concatenated straight into `sh -c`. End the command and read the flag file.
- **Templar.** The tool rejects `; & | ` backtick and newline, then still concatenates. The Acolyte separator is
  blocked, so it fails. Command substitution contains none of those; its output lands in the echoed status line.
- **Divine.** No shell: `execFile('ping', ['-c','1','-W','1', host])` with an argument array, and `host` is validated
  against a strict hostname/IP pattern first. The page reports the rejection clearly (with the Indonesian line beneath
  the English one). Nothing can chain or substitute a command. No flag.

Note: `ping` may lack `CAP_NET_RAW` under the range hardening and fail; that is intentional and irrelevant — the flaw
and the flag path run through `echo`/the shell, not through a successful ping.

## Reference solves

`solve/acolyte.mjs` and `solve/templar.mjs` are HTTP clients; the reference solve contains the intended shell input for
each level. `npm run labs:test -- --lab r03` proves each works at its level and that the Acolyte input fails at Templar
and Divine.
