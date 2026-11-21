// labs/r03-beacon/app/server.mjs — Beacon, a router admin panel. Start hook: read the one-shot flag file
// (HVWA_FLAG_FILE) once and unlink it, then write it (or a Divine decoy) to /tmp/beacon/flag.txt (spec §6).
// The only shell in the app is the /diagnostics probe (diag.mjs); every other page is rendered from seed/device.json.
// No page renders the flag file; only a shell that reads it does. Listens on 0.0.0.0:$HVWA_PORT.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { probe } from './diag.mjs';
import {
  page, esc, led, badge, stat, gauge, sparkline, meter, signalBars, table, deviceArt,
} from './render.mjs';

const LEVELS = ['acolyte', 'templar', 'divine'];
const level = LEVELS.includes(process.env.HVWA_LEVEL ?? '') ? process.env.HVWA_LEVEL : 'acolyte';
const port = Number(process.env.HVWA_PORT || 8080);
const device = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'seed', 'device.json'), 'utf8'));
const flagSource = process.env.HVWA_FLAG_FILE || '/tmp/.hvwa-flag';

/** Poll for the one-shot flag file, read it once and unlink it. Below Divine only; otherwise exit non-zero. */
async function readFlag() {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const value = readFileSync(flagSource, 'utf8').trim();
      if (value) { unlinkSync(flagSource); return value; }
    } catch { /* the warden has not written it yet */ }
    if (Date.now() >= deadline) {
      console.error('beacon: the flag file never appeared'); // never the flag itself
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const flag = level === 'divine' ? undefined : await readFlag();
mkdirSync('/tmp/beacon', { recursive: true });
writeFileSync('/tmp/beacon/flag.txt',
  `${level === 'divine' || !flag ? 'Divine is the secure reference: the probe runs no shell, so there is nothing to inject.' : flag}\n`,
  { mode: 0o400 });

// ---- in-memory state (this process only): recent probe hosts, never probe output or the flag file ----------------
const RECENT = [];
const RECENT_MAX = 8;
function remember(host, ok, ms) {
  RECENT.unshift({ host: String(host).slice(0, 200), at: new Date().toISOString(), ok, ms });
  if (RECENT.length > RECENT_MAX) RECENT.length = RECENT_MAX;
}

const html = (res, status, body) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
const readBody = (req) => new Promise((resolve, reject) => {
  let b = '';
  let settled = false;
  const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } }; // never settle twice
  req.on('data', (c) => { b += c; if (b.length > 4096) req.destroy(); });
  req.on('end', () => settle(resolve, b));
  req.on('error', (err) => settle(reject, err));
  req.on('close', () => settle(reject, new Error('request closed before the body was read')));
});

// ---- small view helpers ------------------------------------------------------------------------------------------
const S = device.system;
const kv = (k, v) => `<span class="kv-chip"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></span>`;
const card = (title, inner, headExtra = '', className = '') =>
  `<section class="card ${className}"><div class="card-head"><h3>${esc(title)}</h3>${headExtra}</div>${inner}</section>`;
const tile = (label, value, sub, tone) => `<div class="card tight">${stat(label, value, sub, tone)}</div>`;

const SEV_TONE = { info: 'lime', notice: 'cyan', warning: 'amber', error: 'red', debug: 'violet' };
const stateBadge = (state) => (state === 'up' || state === 'running'
  ? badge(state === 'up' ? 'up' : 'running', 'lime')
  : badge(state, 'red'));

// The Indonesian line is a static translation of the known probe messages, shown beneath the English rejection.
const ID_NOTES = {
  'Enter a valid hostname or IP address.': 'Masukkan nama host atau alamat IP yang valid.',
  'That host contains characters that are not allowed.': 'Host tersebut mengandung karakter yang tidak diizinkan.',
  'Could not read the request body.': 'Tidak dapat membaca isi permintaan.',
};

function probeHistory() {
  if (RECENT.length === 0) return '<p class="empty">No probes in this session yet.</p>';
  return `<div class="history">${RECENT.map((p) => `<div class="row">`
    + `<span>${p.ok ? led('lime') : led('red')}</span>`
    + `<span class="h-host" title="${esc(p.host || '(empty)')}">${esc(p.host || '(empty)')}</span>`
    + `<span class="h-time">${esc(p.at.slice(11, 19))}Z · ${p.ok ? `ok ${p.ms} ms` : 'rejected'}</span>`
    + `</div>`).join('')}</div>`;
}

// ---- / : dashboard -----------------------------------------------------------------------------------------------
function dashboardPage() {
  const w = device.wan;
  const l = device.lan;
  const wifi = device.wifi;
  const clients = device.clients;
  const online = clients.filter((c) => c.online).length;
  const topClients = clients.slice(0, 4);
  const recentLogs = device.logs.slice(0, 4);

  const links = ['/network', '/wifi', '/diagnostics', '/logs', '/firmware', '/system']
    .map((href) => `<a class="chip" href="${href}">${esc(href.slice(1))}</a>`).join('');

  const body = `
  <div class="page-head"><div><div class="eyebrow">Overview</div><h2>Dashboard</h2>
    <p class="lede">Live state of ${esc(device.model)} at ${esc(device.hostname)}. Every value is read from the appliance's own status plane.</p></div></div>

  <section class="card hero">
    <div>
      <div class="eyebrow">${esc(device.model)} · ${esc(device.hardware)}</div>
      <h2>${esc(device.hostname)}</h2>
      <p class="model-line">SN ${esc(device.serial)} · firmware ${esc(device.firmware)} (${esc(device.firmwareBuild)}) · ${esc(device.locale)}</p>
      <div class="kv">
        ${kv('Uptime', device.uptime)}
        ${kv('Last boot', device.lastBoot)}
        ${kv('WAN', `${w.ipv4} · ${w.type}`)}
        ${kv('LAN', l.ipv4)}
      </div>
    </div>
    <div>${deviceArt()}</div>
  </section>

  <div class="grid cols" style="margin-top:16px">
    ${tile('WAN link', w.state === 'up' ? 'Online' : 'Down', `${w.ipv4} · ${w.rxMbps} Mb/s down`, w.state === 'up' ? 'lime' : 'red')}
    ${tile('LAN clients', `${online} / ${clients.length}`, `DHCP ${l.dhcp.used} of ${l.dhcp.pool} leases`, 'cyan')}
    ${tile('Wi-Fi', wifi.ssid, `${wifi.security} · ${wifi.bands.reduce((n, b) => n + b.clients, 0)} wireless clients`, 'lime')}
    ${tile('Firmware', device.firmware, `${device.firmwareChannel} channel · ${device.firmwareBuild}`, 'amber')}
    ${tile('Board temperature', `${S.temperatureC} °C`, `fan ${S.fanRpm} rpm`, 'amber')}
  </div>

  <div class="grid two" style="margin-top:16px">
    ${card('Processor & memory', `
      <div class="gauges">
        ${gauge('CPU load', S.cpuPercent, `${S.cpuPercent}%`, 'lime')}
        ${gauge('Memory', S.memoryPercent, `${S.memoryPercent}%`, 'cyan')}
        ${gauge('Temp', (S.temperatureC / 90) * 100, `${S.temperatureC}°`, 'amber')}
      </div>
      <div class="spark-wrap" style="margin-top:18px">${sparkline(S.cpuHistory, 'lime', 'CPU load, last 60 seconds')}
        <div class="spark-meta"><span>CPU load · last 60 s</span><span>${S.cpuCores} cores · load ${S.loadAverage.map((n) => n.toFixed(2)).join(' ')}</span></div>
      </div>
      <div class="spark-wrap" style="margin-top:14px">${sparkline(S.wanHistory, 'cyan', 'WAN throughput, last 60 seconds')}
        <div class="spark-meta"><span>WAN throughput · last 60 s</span><span>${w.rxMbps} Mb/s down · ${w.txMbps} Mb/s up</span></div>
      </div>`)}

    ${card('Power & maintenance', `
      <div class="reboot-widget">
        <input type="checkbox" id="reboot-toggle" class="sr-only">
        <label for="reboot-toggle" class="btn ghost trigger">Reboot device</label>
        <div class="reboot">
          <div class="reboot-bar"><span></span></div>
          <p class="reboot-msg">Rebooting ${esc(device.model)}…</p>
          <p class="reboot-done">Back online · services resumed</p>
        </div>
        <p class="note">Simulated — this range appliance stays online. The animation is CSS only.</p>
      </div>
      <div class="presets" style="margin-top:16px">${links}</div>`)}
  </div>

  <div class="grid two" style="margin-top:16px">
    ${card('Connected clients', table(
      ['Client', 'IP', 'Link', 'Signal'],
      topClients.map((c) => [
        { html: `${c.online ? led('lime') : led('red')} ${esc(c.name)}` },
        c.ip,
        `${c.iface} · ${c.rate}`,
        c.signal === '—' ? 'wired' : `${signalBars(c.signalLevel)} ${c.signal}`,
      ]),
    ), `<a href="/network">all clients →</a>`)}

    ${card('Recent events', table(
      ['Time', 'Event'],
      recentLogs.map((e) => [
        e.ts.slice(11, 19),
        { html: `${badge(e.severity, SEV_TONE[e.severity] || 'dim')} <span class="muted">${esc(e.message)}</span>` },
      ]),
    ), `<a href="/logs">full log →</a>`)}
  </div>`;

  return page('Dashboard', body, { active: '/', device });
}

// ---- /network ----------------------------------------------------------------------------------------------------
function networkPage() {
  const w = device.wan;
  const l = device.lan;
  const clients = device.clients;

  const body = `
  <div class="page-head"><div><div class="eyebrow">Connectivity</div><h2>Network</h2>
    <p class="lede">WAN uplink, LAN bridge, DHCP leases and connected clients on ${esc(device.model)}.</p></div></div>

  <div class="grid three">
    ${card('WAN', `
      <div class="stat">${stat('Uplink', w.state === 'up' ? 'Connected' : 'Down', `${w.type} · ${w.iface}`, w.state === 'up' ? 'lime' : 'red')}</div>
      <div class="kv" style="margin-top:14px">
        ${kv('Address', w.ipv4)}${kv('Gateway', w.gateway)}${kv('MTU', w.mtu)}${kv('Lease', `${w.lease} · ${w.leaseExpires.slice(0, 10)}`)}
      </div>`)}

    ${card('LAN', `
      <div class="stat">${stat('Bridge', l.iface, `${l.ipv4} · ${clients.filter((c) => c.online).length} online`, 'cyan')}</div>
      <div class="kv" style="margin-top:14px">
        ${kv('Gateway', l.gateway)}${kv('DHCP pool', `${l.dhcp.start} – ${l.dhcp.end}`)}${kv('Lease time', `${l.dhcp.leaseHours} h`)}${kv('Leases used', `${l.dhcp.used} / ${l.dhcp.pool}`)}
      </div>`)}

    ${card('Throughput', `
      <div class="meter-row"><span>WAN down</span><span class="v">${w.rxMbps} Mb/s</span></div>
      ${meter((w.rxMbps / w.linkMbps) * 100, 'lime')}
      <div class="meter-row" style="margin-top:14px"><span>WAN up</span><span class="v">${w.txMbps} Mb/s</span></div>
      ${meter((w.txMbps / w.linkMbps) * 100, 'cyan')}
      <div class="meter-row" style="margin-top:14px"><span>Link</span><span class="v">${w.linkMbps} Mb/s</span></div>
      ${meter(100, 'lime')}`)}
  </div>

  ${card('Interfaces', table(
    ['Interface', 'Role', 'State', 'IPv4', 'MAC', 'RX', 'TX'],
    device.interfaces.map((i) => [i.name, i.role, { html: stateBadge(i.state) }, i.ipv4, i.mac, i.rx, i.tx]),
  ))}

  <div class="grid two" style="margin-top:16px">
    ${card('DHCP leases', table(
      ['Hostname', 'IP', 'MAC', 'Expires', 'Iface'],
      device.dhcpLeases.map((d) => [d.hostname, d.ip, d.mac, d.expires, d.iface]),
    ))}

    ${card('Firewall rules', table(
      ['Rule', 'Action', 'Proto', 'Source', 'Dest'],
      device.firewall.map((f) => [
        f.id,
        { html: f.action === 'accept' ? badge('accept', 'lime') : badge(f.action, 'red') },
        f.proto,
        f.source,
        `${f.dest}${f.port !== 'any' ? `:${f.port}` : ''}`,
      ]),
    ))}
  </div>

  ${card('Connected clients', table(
    ['Client', 'IP', 'MAC', 'Link', 'Signal', 'Rate', 'Last seen'],
    clients.map((c) => [
      { html: `${c.online ? led('lime') : led('red')} ${esc(c.name)}` },
      c.ip, c.mac, `${c.iface} · ${c.band}`,
      c.signal === '—' ? 'wired' : `${signalBars(c.signalLevel)} ${c.signal}`,
      c.rate, c.lastSeen,
    ]),
  ), `<span class="badge badge-dim">${clients.length} entries</span>`)}`;

  return page('Network', body, { active: '/network', device });
}

// ---- /wifi -------------------------------------------------------------------------------------------------------
function wifiPage() {
  const wifi = device.wifi;
  const bandCount = wifi.bands.reduce((n, b) => n + b.clients, 0);

  const body = `
  <div class="page-head"><div><div class="eyebrow">Wireless</div><h2>Wi-Fi</h2>
    <p class="lede">Both radios on ${esc(device.model)}: SSID, security, channels and associated clients.</p></div></div>

  <div class="grid cols">
    ${tile('SSID', wifi.ssid, wifi.hidden ? 'hidden network' : 'broadcasting', 'lime')}
    ${tile('Security', wifi.security, 'WPA3 transition disabled', 'cyan')}
    ${tile('Channel', `${wifi.bands[1]?.channel ?? '—'}`, `5 GHz · ${wifi.bands[1]?.width ?? ''}`, 'amber')}
    ${tile('Clients', `${bandCount}`, 'associated across both bands', 'lime')}
    ${tile('Guest network', wifi.guestEnabled ? wifi.guestSsid : 'Off', wifi.guestIsolation ? 'client isolation on' : 'isolation off', 'violet')}
  </div>

  ${card('Radios', table(
    ['Band', 'Channel', 'Width', 'TX power', 'Clients', 'Utilisation'],
    wifi.bands.map((b) => [
      b.band, String(b.channel), b.width, b.txPower, String(b.clients),
      { html: `<div style="min-width:120px">${meter(b.utilisation, b.utilisation > 65 ? 'amber' : 'lime')}<span class="muted" style="font-size:11px">${b.utilisation}%</span></div>` },
    ]),
  ))}

  ${card('Wireless clients', table(
    ['Client', 'IP', 'MAC', 'Band', 'Signal', 'Rate'],
    wifi.clients.map((c) => [
      c.name, c.ip, c.mac, c.band,
      { html: `${signalBars(c.signalLevel)} ${esc(c.signal)}` },
      c.rate,
    ]),
  ), `<span class="badge badge-dim">${wifi.clients.length} associated</span>`)}`;

  return page('Wi-Fi', body, { active: '/wifi', device });
}

// ---- /logs -------------------------------------------------------------------------------------------------------
function logsPage() {
  const counts = device.logs.reduce((acc, e) => { acc[e.severity] = (acc[e.severity] || 0) + 1; return acc; }, {});
  const chips = Object.entries(SEV_TONE)
    .filter(([sev]) => counts[sev])
    .map(([sev, tone]) => `<span class="chip">${badge(sev, tone)} ${counts[sev]}</span>`).join('');

  const body = `
  <div class="page-head"><div><div class="eyebrow">Observability</div><h2>System log</h2>
    <p class="lede">Recent syslog entries from the appliance, plus probes this diagnostics process has handled.</p></div></div>

  <div class="presets" style="margin:0 0 16px">${chips}</div>

  ${card('Syslog', table(
    ['Time', 'Level', 'Source', 'Message'],
    device.logs.map((e) => [
      e.ts.replace('T', ' ').slice(0, 19),
      { html: badge(e.severity, SEV_TONE[e.severity] || 'dim') },
      e.source,
      e.message,
    ]),
  ))}

  <div class="grid two" style="margin-top:16px">
    ${card('Recent probe entries', `<p class="note" style="margin:0 0 10px">Held in memory for this browser session only; never written to disk.</p>${probeHistory()}`)}
    ${card('Log retention', `
      <p class="note">Syslog is kept in a 512 KiB ring buffer on the appliance; the oldest entries are overwritten first.</p>
      <div class="meter-row" style="margin-top:14px"><span>Buffer used</span><span class="v">38%</span></div>
      ${meter(38, 'cyan')}
      <div class="callout" style="margin-top:14px"><span class="dot"></span><span>Remote syslog forwarding is disabled on this device.</span></div>`)}
  </div>`;

  return page('Logs', body, { active: '/logs', device });
}

// ---- /firmware ---------------------------------------------------------------------------------------------------
function firmwarePage() {
  const changes = device.changelog.map((c) => `
    <div class="card tight" style="margin-top:10px">
      <div class="card-head"><h3>v${esc(c.version)}</h3><span class="badge badge-dim">${esc(c.date)}</span></div>
      <ul class="note" style="margin:0;padding-left:18px">${c.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
    </div>`).join('');

  const body = `
  <div class="page-head"><div><div class="eyebrow">Maintenance</div><h2>Firmware</h2>
    <p class="lede">Installed build, update channel and release history for ${esc(device.model)}.</p></div></div>

  <div class="grid two">
    ${card('Installed', `
      <div class="stat">${stat('Firmware', device.firmware, `${device.firmwareChannel} channel · built ${device.firmwareBuild}`, 'lime')}</div>
      <div class="kv" style="margin-top:14px">
        ${kv('Hardware', device.hardware)}${kv('Serial', device.serial)}${kv('Hostname', device.hostname)}${kv('Last boot', device.lastBoot)}
      </div>`)}
    ${card('Update status', `
      <div class="callout"><span class="dot"></span><span>This device is up to date on the ${esc(device.firmwareChannel)} channel.</span></div>
      <p class="note" style="margin-top:14px">Automatic updates are disabled on range appliances. The update server has no route out of this network, so no download can be offered.</p>
      <button class="btn ghost" type="button" disabled title="No outbound update route on this appliance">Check for updates</button>`)}
  </div>

  ${card('Changelog', changes, `<span class="badge badge-dim">${device.changelog.length} releases</span>`)}`;

  return page('Firmware', body, { active: '/firmware', device });
}

// ---- /system -----------------------------------------------------------------------------------------------------
function systemPage() {
  const body = `
  <div class="page-head"><div><div class="eyebrow">Appliance</div><h2>System</h2>
    <p class="lede">Resource use, running services and administrative sessions on ${esc(device.model)}.</p></div></div>

  <div class="grid two">
    ${card('Resources', `
      <div class="gauges">
        ${gauge('CPU load', S.cpuPercent, `${S.cpuPercent}%`, 'lime')}
        ${gauge('Memory', S.memoryPercent, `${S.memoryPercent}%`, 'cyan')}
        ${gauge('Temp', (S.temperatureC / 90) * 100, `${S.temperatureC}°`, 'amber')}
      </div>
      <div class="meter-row" style="margin-top:18px"><span>Memory · ${S.memoryUsedMiB} / ${S.memoryTotalMiB} MiB</span><span class="v">${S.memoryPercent}%</span></div>
      ${meter(S.memoryPercent, 'cyan')}
      <div class="meter-row" style="margin-top:14px"><span>Storage · ${S.storageUsedMiB} / ${S.storageTotalMiB} MiB</span><span class="v">${Math.round((S.storageUsedMiB / S.storageTotalMiB) * 100)}%</span></div>
      ${meter((S.storageUsedMiB / S.storageTotalMiB) * 100, 'lime')}`)}

    ${card('Vitals', `
      <div class="grid cols" style="gap:14px">
        ${tile('CPU', `${S.cpuPercent}%`, `${S.cpuModel}`, 'lime')}
        ${tile('Load average', S.loadAverage.map((n) => n.toFixed(2)).join(' '), '1 · 5 · 15 min', 'cyan')}
        ${tile('Fan', `${S.fanRpm} rpm`, 'chassis intake', 'cyan')}
        ${tile('Board temp', `${S.temperatureC} °C`, 'threshold 85 °C', 'amber')}
      </div>
      <div class="reboot-widget" style="margin-top:16px">
        <input type="checkbox" id="reboot-toggle" class="sr-only">
        <label for="reboot-toggle" class="btn ghost trigger">Reboot device</label>
        <div class="reboot">
          <div class="reboot-bar"><span></span></div>
          <p class="reboot-msg">Rebooting ${esc(device.model)}…</p>
          <p class="reboot-done">Back online · services resumed</p>
        </div>
      </div>`)}
  </div>

  <div class="grid two" style="margin-top:16px">
    ${card('Services', table(
      ['Service', 'Description', 'State', 'PID', 'Uptime'],
      S.services.map((s) => [s.name, s.desc, { html: stateBadge(s.state) }, String(s.pid), s.uptime]),
    ))}

    ${card('Admin sessions', table(
      ['User', 'From', 'Via', 'Idle', 'Since'],
      S.sessions.map((s) => [s.user, s.from, s.via, s.idle, s.since.replace('T', ' ').slice(0, 19)]),
    ))}
  </div>`;

  return page('System', body, { active: '/system', device });
}

// ---- /status -----------------------------------------------------------------------------------------------------
function statusPage() {
  const w = device.wan;
  const l = device.lan;
  const clients = device.clients;

  const body = `
  <div class="page-head"><div><div class="eyebrow">Summary</div><h2>Status</h2>
    <p class="lede">A human-readable snapshot of the device, its interfaces, name resolution and clients.</p></div></div>

  <div class="grid two">
    ${card('Device', table(['Field', 'Value'], [
      ['Model', device.model], ['Serial', device.serial], ['Hardware', device.hardware],
      ['Firmware', `${device.firmware} (${device.firmwareBuild})`], ['Hostname', device.hostname],
      ['Uptime', device.uptime], ['Last boot', device.lastBoot], ['Locale', device.locale],
    ]))}

    ${card('WAN / LAN', table(['Field', 'Value'], [
      ['WAN interface', `${w.iface} · ${w.type}`], ['WAN address', w.ipv4], ['WAN gateway', w.gateway],
      ['WAN lease', w.lease], ['LAN bridge', `${l.iface} · ${l.ipv4}`], ['DHCP range', `${l.dhcp.start} – ${l.dhcp.end}`],
      ['Leases', `${l.dhcp.used} / ${l.dhcp.pool}`], ['Clients online', String(clients.filter((c) => c.online).length)],
    ]))}
  </div>

  ${card('Interfaces', table(
    ['Interface', 'Role', 'State', 'IPv4', 'MAC', 'MTU'],
    device.interfaces.map((i) => [i.name, i.role, { html: stateBadge(i.state) }, i.ipv4, i.mac, String(i.mtu)]),
  ))}

  <div class="grid two" style="margin-top:16px">
    ${card('Name resolution', table(['Setting', 'Value'], [
      ['Upstream DNS', device.dns.servers.join(', ')], ['Search domain', device.dns.searchDomain],
      ['Local names', String(device.dns.localNames)], ['Cache entries', String(device.dns.cacheEntries)],
      ['DNSSEC', device.dns.dnssec ? 'validated' : 'off'],
    ]))}

    ${card('Routes', table(
      ['Destination', 'Gateway', 'Iface', 'Metric', 'Type'],
      device.routes.map((r) => [r.destination, r.gateway, r.iface, String(r.metric), r.type]),
    ))}
  </div>

  ${card('Clients', table(
    ['Client', 'IP', 'MAC', 'Link', 'State'],
    clients.map((c) => [
      c.name, c.ip, c.mac, `${c.iface} · ${c.band}`,
      { html: c.online ? badge('online', 'lime') : badge('offline', 'dim') },
    ]),
  ), `<a href="/network">network detail →</a>`)}`;

  return page('Status', body, { active: '/status', device });
}

// ---- /diagnostics : the vulnerable feature (the shell lives in diag.mjs) -----------------------------------------
function diagPage({ host = '', result = null, at = '', ms = 0 } = {}) {
  const ok = result && !result.error;
  const presets = [['Gateway', '192.168.1.1'], ['DNS resolver', '1.1.1.1'], ['Public DNS', '8.8.8.8']]
    .map(([label, ip]) => `<a class="chip" href="/diagnostics?host=${ip}"><span class="dot"></span>${esc(label)} · ${esc(ip)}</a>`).join('');

  let termBody;
  if (!result) {
    termBody = `<div class="term-idle">$ beacon probe --host &lt;address&gt;<br>awaiting input…</div>`;
  } else if (result.error) {
    termBody = `<pre class="term-body"><span class="cmd">$ probe ${esc(host)}</span>\n`
      + `<span class="term-hint"># ${esc(at)} · exit 2</span>\n${esc(result.error)}</pre>`;
  } else {
    termBody = `<pre class="term-body"><span class="cmd">$ probe ${esc(host)}</span>\n`
      + `<span class="term-hint"># ${esc(at)} · exit 0 · ${ms} ms</span>\n${esc(result.output)}</pre>`;
  }

  const reject = result && result.error
    ? `<div class="reject"><div class="r-title">${led('red')}Probe rejected</div>`
      + `<div class="r-en">${esc(result.error)}</div>`
      + (ID_NOTES[result.error] ? `<div class="r-id">${esc(ID_NOTES[result.error])}</div>` : '')
      + `</div>`
    : '';

  const body = `
  <div class="page-head"><div><div class="eyebrow">Tools</div><h2>Connectivity diagnostics</h2>
    <p class="lede">Probe a host from the router and inspect the raw reply. Use the presets for common targets, or type a hostname or IP address.</p></div></div>

  <div class="grid two">
    ${card('Run a probe', `
      <form method="post" action="/diagnostics" data-probe class="probe-form">
        <label class="field" for="host"><span class="prompt" aria-hidden="true">$</span>
          <input id="host" name="host" value="${esc(host)}" placeholder="hostname or IP address" autocomplete="off" spellcheck="false" aria-label="Host to probe"></label>
        <button class="btn" type="submit">Run probe</button>
      </form>
      <div class="presets"><span class="lbl">Presets</span>${presets}</div>
      <p class="note" style="margin-top:14px">The probe runs on the appliance itself and returns the combined output of the diagnostic command.</p>`)}

    ${card('Recent probes', `<p class="note" style="margin:0 0 10px">In memory for this process only; outputs are never retained.</p>${probeHistory()}`)}
  </div>

  <div class="term" id="probe-term">
    <div class="term-bar">
      <div class="lights" aria-hidden="true"><i></i><i></i><i></i></div>
      <span class="title">diagnostic console</span>
      <span class="meta"><span class="cmd-id">${result ? (ok ? `exit 0 · ${ms} ms` : 'exit 2') : 'idle'}</span></span>
    </div>
    <div class="term-status"><span class="spinner" aria-hidden="true"></span> probing, one moment…</div>
    ${termBody}
  </div>
  ${reject}`;

  return page('Diagnostics', body, { active: '/diagnostics', device });
}

function notFoundPage(path) {
  const body = `
  <div class="page-head"><div><div class="eyebrow">404</div><h2>No such page</h2>
    <p class="lede">The appliance has no route for <span class="mono-inline">${esc(path)}</span>.</p></div></div>
  <section class="card hero">
    <div>
      <div class="eyebrow">Route not found</div>
      <h2>That page isn't wired up.</h2>
      <p class="model-line">Check the address, or head back to the dashboard.</p>
      <div class="presets" style="margin-top:16px"><a class="chip" href="/"><span class="dot"></span>Back to dashboard</a><a class="chip" href="/diagnostics">Diagnostics</a></div>
    </div>
    <div>${deviceArt()}</div>
  </section>`;
  return page('Not found', body, { active: '', device });
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://beacon');
  const p = url.pathname;

  if (p === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"status":"ok"}'); }

  if (req.method === 'GET') {
    if (p === '/') return html(res, 200, dashboardPage());
    if (p === '/network') return html(res, 200, networkPage());
    if (p === '/wifi') return html(res, 200, wifiPage());
    if (p === '/logs') return html(res, 200, logsPage());
    if (p === '/firmware') return html(res, 200, firmwarePage());
    if (p === '/system') return html(res, 200, systemPage());
    if (p === '/status') return html(res, 200, statusPage());
    if (p === '/diagnostics') return html(res, 200, diagPage({ host: url.searchParams.get('host') ?? '' }));
    if (p === '/favicon.ico' || p === '/favicon.svg') { res.writeHead(204, { 'cache-control': 'max-age=86400' }); return res.end(); }
  }

  if (p === '/diagnostics' && req.method === 'POST') {
    let host;
    try {
      host = new URLSearchParams(await readBody(req)).get('host') ?? '';
    } catch {
      return html(res, 400, diagPage({ host: '', result: { error: 'Could not read the request body.' } }));
    }
    const started = Date.now();
    const r = await probe(level, host);
    const ms = Date.now() - started;
    const at = new Date().toISOString().replace('T', ' ').slice(0, 19);
    remember(host, !r.error, ms);
    return html(res, 200, diagPage({ host, result: r, at, ms }));
  }

  return html(res, 404, notFoundPage(p));
}).listen(port, '0.0.0.0', () => console.log(`beacon on :${port} (${level})`));
