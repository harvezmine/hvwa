// labs/r03-beacon/app/render.mjs — the Beacon "network gear" look and HTML helpers. Everything the server reflects
// (hosts, log lines, client names, probe history) goes through esc(); values that are pre-built markup are passed as
// { html } cells explicitly, so no seed or user string is ever interpolated raw. Inline SVG + CSS only: no external
// assets, fonts or scripts. The injection flaw lives in the shell (diag.mjs), never in this markup.

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// An inline SVG favicon (percent-encoded # as %23) so there is no external asset to fetch.
const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E"
  + "%3Crect width='32' height='32' rx='7' fill='%230a0e14'/%3E"
  + "%3Ccircle cx='16' cy='17' r='3' fill='%239ae63f'/%3E"
  + "%3Cpath d='M10 17a6 6 0 0 1 12 0' fill='none' stroke='%239ae63f' stroke-width='2.4' stroke-linecap='round'/%3E"
  + "%3Cpath d='M6 17a10 10 0 0 1 20 0' fill='none' stroke='%23f6b93b' stroke-width='2.4' stroke-linecap='round'/%3E%3C/svg%3E";

const CSS = `
:root{
  --bg:#080b10;--bg2:#0b1017;--panel:#111823;--panel2:#0d141d;--line:#1f2a39;--line2:#2c3a4e;
  --ink:#dbe4ef;--ink2:#b6c2d3;--mut:#8593a8;--dim:#5b6879;
  --lime:#9ae63f;--lime2:#c8f57a;--amber:#f6b93b;--red:#ff6b6b;--cyan:#5ad1e6;--violet:#8a7dff;
  --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,"SFMono-Regular","Cascadia Code","JetBrains Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html{color-scheme:dark}
body{margin:0;background:
  radial-gradient(1200px 500px at 80% -120px,rgba(154,230,63,.10),transparent 60%),
  radial-gradient(900px 480px at 0% -80px,rgba(90,209,230,.08),transparent 55%),
  linear-gradient(180deg,var(--bg) 0%,var(--bg2) 100%);
  background-attachment:fixed;color:var(--ink);font:15px/1.55 var(--sans);min-height:100vh}
a{color:var(--lime);text-decoration:none}
a:hover{color:var(--lime2)}
h1,h2,h3{margin:0}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.skip{position:absolute;left:16px;top:-4rem;z-index:50;background:var(--lime);color:#0a1206;padding:10px 16px;border-radius:0 0 8px 8px;font:700 13px/1 var(--sans)}
.skip:focus{top:0}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px}

/* header + nav */
.top{background:linear-gradient(180deg,rgba(14,20,29,.96),rgba(10,14,20,.92));border-bottom:1px solid var(--line);
  position:sticky;top:0;z-index:20;backdrop-filter:blur(8px)}
.top .wrap{display:flex;align-items:center;gap:16px;min-height:66px}
.brand{display:flex;align-items:center;gap:13px;min-width:0}
.logo{width:40px;height:40px;flex:none}
.brand h1{font:800 19px/1 var(--sans);letter-spacing:.16em;color:var(--ink)}
.brand .sub{display:block;margin-top:5px;font:12px/1 var(--mono);color:var(--mut);letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topright{margin-left:auto;display:flex;align-items:center;gap:10px}
.pill{display:inline-flex;align-items:center;gap:8px;padding:6px 11px;border:1px solid var(--line2);border-radius:999px;
  font:600 11px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink2);background:var(--panel2)}
.pill.online{color:var(--lime);border-color:rgba(154,230,63,.35);background:rgba(154,230,63,.07)}
.tabs{background:rgba(9,13,19,.9);border-bottom:1px solid var(--line);position:sticky;top:66px;z-index:19}
.tabs .wrap{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none;padding:8px 20px}
.tabs .wrap::-webkit-scrollbar{display:none}
.tabs a{padding:8px 13px;border-radius:8px;color:var(--mut);font:600 13px/1 var(--sans);white-space:nowrap;border:1px solid transparent}
.tabs a:hover{color:var(--ink);background:var(--panel)}
.tabs a.active{color:var(--lime);background:rgba(154,230,63,.09);border-color:rgba(154,230,63,.28)}

main{padding:26px 0 40px}
.page-head{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;margin-bottom:18px}
.page-head h2{font:700 24px/1.15 var(--sans);letter-spacing:-.01em}
.page-head .lede{color:var(--mut);font-size:13.5px;max-width:62ch}
.eyebrow{font:700 11px/1 var(--mono);letter-spacing:.18em;text-transform:uppercase;color:var(--dim);margin-bottom:8px}

/* grids + cards */
.grid{display:grid;gap:16px}
.grid.cols{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.grid.two{grid-template-columns:1.35fr 1fr}
.grid.three{grid-template-columns:repeat(3,1fr)}
.card{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:14px;padding:18px;
  box-shadow:0 1px 0 rgba(255,255,255,.03) inset,0 14px 30px -22px rgba(0,0,0,.9)}
.card.tight{padding:14px}
.card h3{font:700 13px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--mut);margin-bottom:14px}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.card-head h3{margin:0}

/* hero */
.hero{display:grid;grid-template-columns:1.1fr .9fr;gap:18px;align-items:center;overflow:hidden}
.hero .device-art{width:100%;height:auto;display:block}
.hero h2{font:800 28px/1.1 var(--sans);letter-spacing:-.01em}
.hero .model-line{margin-top:8px;color:var(--mut);font:13px/1.6 var(--mono)}
.hero .kv{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.kv-chip{border:1px solid var(--line2);border-radius:9px;padding:8px 11px;background:var(--panel2);min-width:0}
.kv-chip .k{display:block;font:600 10px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
.kv-chip .v{display:block;margin-top:5px;font:600 13px/1.2 var(--mono);color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* stats */
.stat{display:flex;flex-direction:column;gap:9px}
.stat .label{font:600 11px/1 var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--mut);display:flex;align-items:center;gap:8px}
.stat .value{font:700 26px/1 var(--mono);color:var(--ink);letter-spacing:-.01em}
.stat .value small{font-size:13px;color:var(--mut);font-weight:600;margin-left:3px}
.stat .sub{font-size:12px;color:var(--dim);font-family:var(--mono)}
.led{width:9px;height:9px;border-radius:50%;display:inline-block;flex:none;background:var(--dim);
  box-shadow:0 0 0 3px rgba(255,255,255,.03)}
.led-lime{background:var(--lime);box-shadow:0 0 9px rgba(154,230,63,.75)}
.led-amber{background:var(--amber);box-shadow:0 0 9px rgba(246,185,59,.6)}
.led-red{background:var(--red);box-shadow:0 0 9px rgba(255,107,107,.65)}
.led-cyan{background:var(--cyan);box-shadow:0 0 9px rgba(90,209,230,.6)}
.led-pulse{animation:pulse 1.8s ease-in-out infinite}

/* gauges + sparklines */
.gauges{display:flex;gap:22px;flex-wrap:wrap;justify-content:space-around;align-items:flex-start}
.gauge{text-align:center}
.gauge-ring{--deg:0deg;--tone:var(--lime);width:112px;height:112px;border-radius:50%;margin:0 auto;
  background:conic-gradient(var(--tone) var(--deg),var(--line) 0);display:grid;place-items:center;position:relative;
  box-shadow:0 0 22px -6px color-mix(in srgb,var(--tone) 55%,transparent)}
.gauge-ring::after{content:"";position:absolute;inset:6px;border-radius:50%;border:1px solid rgba(255,255,255,.04)}
.gauge-hole{width:84px;height:84px;border-radius:50%;background:var(--panel);display:grid;place-items:center;
  font:700 17px/1 var(--mono);color:var(--ink);z-index:1}
.gauge-label{margin-top:10px;font:600 11px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--mut)}
.spark{width:100%;height:56px;display:block}
.spark-wrap{margin-top:2px}
.spark-meta{display:flex;justify-content:space-between;font:11px/1 var(--mono);color:var(--dim);margin-top:7px}

/* badges */
.badge{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:6px;font:700 10.5px/1.3 var(--mono);
  letter-spacing:.06em;text-transform:uppercase;border:1px solid transparent;white-space:nowrap}
.badge-lime{color:var(--lime);background:rgba(154,230,63,.1);border-color:rgba(154,230,63,.28)}
.badge-amber{color:var(--amber);background:rgba(246,185,59,.1);border-color:rgba(246,185,59,.3)}
.badge-red{color:var(--red);background:rgba(255,107,107,.1);border-color:rgba(255,107,107,.3)}
.badge-cyan{color:var(--cyan);background:rgba(90,209,230,.1);border-color:rgba(90,209,230,.3)}
.badge-violet{color:var(--violet);background:rgba(138,125,255,.12);border-color:rgba(138,125,255,.32)}
.badge-dim{color:var(--mut);background:rgba(133,147,168,.08);border-color:var(--line2)}

/* tables */
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:11px}
table{width:100%;border-collapse:collapse;font:13px/1.4 var(--mono);min-width:420px}
thead th{text-align:left;padding:10px 12px;font:700 10.5px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;
  color:var(--dim);background:rgba(255,255,255,.02);border-bottom:1px solid var(--line);white-space:nowrap}
tbody td{padding:10px 12px;border-bottom:1px solid var(--line);color:var(--ink2);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:rgba(154,230,63,.03)}
td .mono{color:var(--ink)}
td .muted{color:var(--dim)}
.num{text-align:right;font-variant-numeric:tabular-nums}

/* signature / notes */
.note{color:var(--mut);font-size:13px;line-height:1.6}
.note code,.mono-inline{font-family:var(--mono);font-size:12.5px;color:var(--ink2);background:rgba(255,255,255,.04);
  padding:1px 5px;border-radius:4px;border:1px solid var(--line)}
.callout{display:flex;gap:12px;padding:13px 15px;border-radius:11px;border:1px solid var(--line2);
  background:rgba(90,209,230,.05);color:var(--ink2);font-size:13px}
.callout.warn{background:rgba(246,185,59,.06);border-color:rgba(246,185,59,.28)}
.callout.bad{background:rgba(255,107,107,.06);border-color:rgba(255,107,107,.3)}
.callout .dot{width:9px;height:9px;border-radius:50%;background:var(--cyan);margin-top:6px;flex:none;box-shadow:0 0 8px rgba(90,209,230,.6)}

/* diagnostics terminal */
.probe-form{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.field{flex:1 1 260px;min-width:0;display:flex;align-items:center;gap:0;background:var(--panel2);border:1px solid var(--line2);
  border-radius:10px;padding:0 3px 0 12px}
.field .prompt{color:var(--lime);font:600 14px/1 var(--mono);padding-right:9px;user-select:none}
.field input{flex:1;min-width:0;background:transparent;border:0;outline:0;color:var(--ink);font:14px/1 var(--mono);padding:12px 4px}
.field input::placeholder{color:var(--dim)}
.field:focus-within{border-color:rgba(154,230,63,.5);box-shadow:0 0 0 3px rgba(154,230,63,.12)}
.btn{font:700 13px/1 var(--sans);border:1px solid transparent;border-radius:10px;padding:12px 18px;cursor:pointer;
  background:var(--lime);color:#0a1206;transition:transform .06s ease,filter .15s ease;white-space:nowrap}
.btn:hover{filter:brightness(1.06)}
.btn:active{transform:translateY(1px)}
.btn.ghost{background:var(--panel2);color:var(--ink2);border-color:var(--line2)}
.presets{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center}
.presets .lbl{font:600 10.5px/1 var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--dim)}
.chip{display:inline-flex;align-items:center;gap:7px;padding:7px 11px;border-radius:8px;border:1px solid var(--line2);
  background:var(--panel2);color:var(--ink2);font:600 12px/1 var(--mono)}
.chip:hover{border-color:rgba(154,230,63,.4);color:var(--lime)}
.chip .dot{width:6px;height:6px;border-radius:50%;background:var(--lime);box-shadow:0 0 6px rgba(154,230,63,.7)}
.term{background:#05080c;border:1px solid var(--line2);border-radius:12px;overflow:hidden;margin-top:16px}
.term-bar{display:flex;align-items:center;gap:8px;padding:9px 13px;background:#0b1119;border-bottom:1px solid var(--line)}
.term-bar .lights{display:flex;gap:6px}
.term-bar .lights i{width:10px;height:10px;border-radius:50%;background:#2a3646}
.term-bar .lights i:nth-child(1){background:#ff5f57}.term-bar .lights i:nth-child(2){background:#febc2e}.term-bar .lights i:nth-child(3){background:#28c840}
.term-bar .title{font:600 11px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--mut)}
.term-bar .meta{margin-left:auto;font:11px/1 var(--mono);color:var(--dim);display:flex;gap:10px;align-items:center}
.term-body{margin:0;padding:15px 16px;font:13px/1.65 var(--mono);color:var(--ink2);white-space:pre-wrap;word-break:break-word;
  max-height:360px;overflow:auto}
.term-body .cmd{color:var(--lime)}
.term-hint{color:var(--dim)}
.term-status{display:none;align-items:center;gap:9px;padding:11px 16px;border-top:1px solid var(--line);
  font:12px/1 var(--mono);color:var(--amber);background:rgba(246,185,59,.04)}
.term.probing .term-status{display:flex}
.term.probing .term-idle{display:none}
.term-idle{padding:15px 16px;font:13px/1.6 var(--mono);color:var(--dim)}
.spinner{width:14px;height:14px;border-radius:50%;border:2px solid rgba(246,185,59,.28);border-top-color:var(--amber);
  animation:spin .7s linear infinite;display:inline-block}
.reject{margin-top:16px;border:1px solid rgba(255,107,107,.34);background:rgba(255,107,107,.06);border-radius:11px;padding:14px 16px}
.reject .r-title{display:flex;align-items:center;gap:9px;font:700 13px/1.3 var(--sans);color:var(--red)}
.reject .r-en{margin-top:7px;color:var(--ink2);font:13px/1.5 var(--mono)}
.reject .r-id{margin-top:4px;color:var(--mut);font:12.5px/1.5 var(--sans);font-style:italic}
.history{margin-top:2px}
.history .row{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--line);font:12.5px/1.4 var(--mono)}
.history .row:last-child{border-bottom:0}
.history .h-host{color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.history .h-label{color:var(--cyan)}
.history .h-time{color:var(--dim);font-size:11.5px}
.empty{color:var(--dim);font:12.5px/1.5 var(--mono);padding:6px 0}

/* signal bars */
.bars{display:inline-flex;align-items:flex-end;gap:2px;height:13px;vertical-align:middle}
.bars i{width:3px;background:var(--line2);border-radius:1px}
.bars i:nth-child(1){height:4px}.bars i:nth-child(2){height:7px}.bars i:nth-child(3){height:10px}.bars i:nth-child(4){height:13px}
.bars.s4 i,.bars.s3 i:nth-child(-n+3),.bars.s2 i:nth-child(-n+2),.bars.s1 i:nth-child(-n+1){background:var(--lime)}

/* util bars */
.meter{height:8px;border-radius:99px;background:var(--line);overflow:hidden}
.meter > span{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--lime),var(--lime2))}
.meter.amber > span{background:linear-gradient(90deg,var(--amber),#ffd479)}
.meter.cyan > span{background:linear-gradient(90deg,var(--cyan),#a3eef7)}
.meter-row{display:flex;justify-content:space-between;font:12px/1.4 var(--mono);color:var(--mut);margin:0 0 6px}
.meter-row .v{color:var(--ink)}

/* reboot widget (pure CSS, checkbox hack) */
.reboot-widget{display:flex;flex-direction:column;gap:12px}
.reboot-widget .trigger{display:inline-flex;align-self:flex-start}
.reboot{display:none}
#reboot-toggle:checked ~ .reboot{display:block}
.reboot-bar{height:8px;border-radius:99px;background:var(--line);overflow:hidden}
.reboot-bar > span{display:block;height:100%;width:0;border-radius:99px;background:linear-gradient(90deg,var(--lime),var(--amber));
  animation:reboot-fill 3.4s ease-in-out forwards}
.reboot-msg{margin:10px 0 0;font:12.5px/1 var(--mono);color:var(--amber);animation:reboot-msg 3.4s ease forwards}
.reboot-done{margin:4px 0 0;font:12.5px/1 var(--mono);color:var(--lime);opacity:0;animation:reboot-done 3.4s ease forwards}

/* footer */
footer{border-top:1px solid var(--line);margin-top:12px;padding:22px 0 34px;color:var(--dim);font:12px/1.6 var(--mono)}
footer .wrap{display:flex;gap:8px 22px;flex-wrap:wrap;align-items:center;justify-content:space-between}
footer .dot-sep{color:var(--line2)}

@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes reboot-fill{0%{width:0}12%{width:6%}70%{width:82%}100%{width:100%}}
@keyframes reboot-msg{0%,72%{opacity:1}86%,100%{opacity:0}}
@keyframes reboot-done{0%,80%{opacity:0}100%{opacity:1}}

@media (max-width:880px){
  .grid.two{grid-template-columns:1fr}
  .grid.three{grid-template-columns:1fr 1fr}
  .hero{grid-template-columns:1fr}
  .hero .device-art{max-width:420px;margin:0 auto}
}
@media (max-width:560px){
  .grid.three{grid-template-columns:1fr}
  .grid.cols{grid-template-columns:1fr}
  main{padding-top:18px}
  .page-head h2{font-size:21px}
  .hero h2{font-size:23px}
  .stat .value{font-size:23px}
  .term-bar .meta .cmd-id{display:none}
  thead{display:none}
  table{min-width:0}
  tbody td{display:flex;justify-content:space-between;gap:14px;padding:9px 12px}
  tbody td::before{content:attr(data-label);color:var(--dim);font:700 10px/1.4 var(--mono);letter-spacing:.08em;
    text-transform:uppercase;flex:none}
  tbody td:not(:last-child){border-bottom:1px solid var(--line)}
  tbody tr{padding:4px 0}
  tbody td[data-label=""]::before{content:none}
}
@media (prefers-reduced-motion:reduce){
  *{animation-duration:.001ms!important;animation-iteration-count:1!important;transition:none!important}
  .spinner{border-top-color:var(--amber)}
  .reboot-bar > span{width:100%}
  .reboot-done{opacity:1}
}
`;

const NAV = [
  ['/', 'Dashboard'],
  ['/network', 'Network'],
  ['/wifi', 'Wi-Fi'],
  ['/diagnostics', 'Diagnostics'],
  ['/logs', 'Logs'],
  ['/firmware', 'Firmware'],
  ['/system', 'System'],
  ['/status', 'Status'],
];

function logo() {
  return `<svg class="logo" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="10" fill="#0d141d" stroke="#2c3a4e"/>`
    + `<circle cx="20" cy="21" r="3.4" fill="#9ae63f"/>`
    + `<path d="M13 21a7 7 0 0 1 14 0" fill="none" stroke="#9ae63f" stroke-width="2.4" stroke-linecap="round"/>`
    + `<path d="M9 21a11 11 0 0 1 22 0" fill="none" stroke="#f6b93b" stroke-width="2.4" stroke-linecap="round"/></svg>`;
}

export function led(tone, extraClass = '') {
  return `<span class="led led-${tone}${extraClass ? ` ${extraClass}` : ''}"></span>`;
}

export function badge(text, tone = 'dim') {
  return `<span class="badge badge-${tone}">${esc(text)}</span>`;
}

export function stat(label, value, sub = '', tone = '') {
  return `<div class="stat"><div class="label">${tone ? led(tone) : ''}${esc(label)}</div>`
    + `<div class="value">${esc(value)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`;
}

export function gauge(label, pct, valueText, tone = 'lime') {
  const deg = (Math.max(0, Math.min(100, Number(pct) || 0)) * 3.6).toFixed(1);
  return `<div class="gauge"><div class="gauge-ring" style="--deg:${deg}deg;--tone:var(--${tone})">`
    + `<div class="gauge-hole">${esc(valueText)}</div></div><div class="gauge-label">${esc(label)}</div></div>`;
}

export function sparkline(series, tone = 'lime', label = 'trend') {
  const data = Array.isArray(series) && series.length > 1 ? series.map(Number) : [0, 0];
  const w = 240, h = 56, pad = 4;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = Math.max(1, max - min);
  const pts = data.map((v, i) => {
    const x = pad + (w - 2 * pad) * (i / (data.length - 1));
    const y = h - pad - (h - 2 * pad) * ((v - min) / span);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const area = `${pad},${h - pad} ${pts} ${w - pad},${h - pad}`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">`
    + `<polygon points="${area}" fill="var(--${tone})" opacity="0.10"/>`
    + `<polyline points="${pts}" fill="none" stroke="var(--${tone})" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

export function meter(pct, tone = 'lime') {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  return `<div class="meter${tone !== 'lime' ? ` ${tone}` : ''}"><span style="width:${v.toFixed(1)}%"></span></div>`;
}

export function signalBars(level) {
  const n = Math.max(1, Math.min(4, Number(level) || 1));
  return `<span class="bars s${n}" aria-label="signal ${n} of 4">` + '<i></i>'.repeat(4) + '</span>';
}

// A table. Cells are plain strings/numbers (always escaped) or { html } for pre-built markup such as badges and LEDs.
export function table(headers, rows, { className = '' } = {}) {
  const cell = (c) => (c && typeof c === 'object' && 'html' in c ? c.html : esc(c));
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c, i) => `<td data-label="${esc(headers[i] ?? '')}">${cell(c)}</td>`).join('')}</tr>`).join('');
  return `<div class="table-wrap${className ? ` ${className}` : ''}"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function deviceArt() {
  const vents = Array.from({ length: 9 }, (_, i) => `<rect x="${184 + i * 9}" y="86" width="4" height="20" rx="2" fill="#1b2635"/>`).join('');
  return `<svg class="device-art" viewBox="0 0 340 156" role="img" aria-label="Beacon B-6 router">`
    + `<defs>`
    + `<linearGradient id="bodyg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c2838"/><stop offset="1" stop-color="#0c131c"/></linearGradient>`
    + `<linearGradient id="edgeg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9ae63f" stop-opacity=".85"/><stop offset="1" stop-color="#f6b93b" stop-opacity=".18"/></linearGradient>`
    + `</defs>`
    + `<ellipse cx="170" cy="142" rx="126" ry="9" fill="#000" opacity=".5"/>`
    + `<line x1="92" y1="60" x2="72" y2="16" stroke="#33425a" stroke-width="4" stroke-linecap="round"/>`
    + `<circle cx="72" cy="16" r="5.5" fill="#9ae63f"/>`
    + `<line x1="248" y1="60" x2="268" y2="16" stroke="#33425a" stroke-width="4" stroke-linecap="round"/>`
    + `<circle cx="268" cy="16" r="5.5" fill="#f6b93b"/>`
    + `<rect x="40" y="58" width="260" height="66" rx="13" fill="url(#bodyg)" stroke="#2c3a4e"/>`
    + `<rect x="46" y="62" width="248" height="6" rx="3" fill="url(#edgeg)"/>`
    + `<rect x="54" y="84" width="6" height="24" rx="3" fill="#1b2635"/>`
    + `<circle cx="70" cy="80" r="3.6" fill="#9ae63f"/><circle cx="84" cy="80" r="3.6" fill="#9ae63f"/>`
    + `<circle cx="98" cy="80" r="3.6" fill="#f6b93b"/><circle cx="112" cy="80" r="3.6" fill="#2c3a4e"/>`
    + `<text x="70" y="112" fill="#5b6879" font-family="ui-monospace,monospace" font-size="11" letter-spacing="2">BEACON B-6</text>`
    + vents
    + `<rect x="278" y="80" width="14" height="26" rx="4" fill="#1b2635" stroke="#2c3a4e"/>`
    + `</svg>`;
}

/** The full document shell: sticky header, tab nav, page body, footer. `ctx.active` is the current route. */
export function page(title, bodyHtml, ctx = {}) {
  const { active = '', device = {} } = ctx;
  const tabs = NAV.map(([href, label]) => `<a href="${href}"${href === active ? ' class="active" aria-current="page"' : ''}>${esc(label)}</a>`).join('');
  const model = device.model || 'Beacon router';
  const firmware = device.firmware || '—';
  const serial = device.serial || '—';
  const hostname = device.hostname || 'beacon';
  const boot = device.lastBoot || '—';

  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    // Honeypot for the view-source crowd — a decoy, not the flag (decoys.ts: c10s3_but_n0_c1g4r).
    + '<!-- firmware debug token: HVWA{c10s3_but_n0_c1g4r} -->'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<meta name="color-scheme" content="dark">`
    + `<title>${esc(title)} — Beacon</title>`
    + `<link rel="icon" href="${FAVICON}">`
    + `<style>${CSS}</style></head><body>`
    + `<a class="skip" href="#main">Skip to content</a>`
    + `<header class="top"><div class="wrap"><div class="brand">${logo()}`
    + `<div><h1>BEACON</h1><span class="sub">${esc(model)} · firmware ${esc(firmware)} · ${esc(hostname)}</span></div>`
    + `</div><div class="topright"><span class="pill online">${led('lime')}Online</span></div></div></header>`
    + `<nav class="tabs" aria-label="Primary"><div class="wrap">${tabs}</div></nav>`
    + `<main id="main"><div class="wrap">${bodyHtml}</div></main>`
    + `<footer><div class="wrap"><span>${esc(model)} <span class="dot-sep">·</span> SN ${esc(serial)}</span>`
    + `<span>Firmware ${esc(firmware)} <span class="dot-sep">·</span> booted ${esc(boot)}</span>`
    + `<span>© 2026 Beacon Systems</span></div></footer>`
    + `<script>(function(){var f=document.querySelector('form[data-probe]');if(!f)return;`
    + `f.addEventListener('submit',function(){var t=document.getElementById('probe-term');if(t)t.classList.add('probing');});})();</script>`
    + `</body></html>`;
}
