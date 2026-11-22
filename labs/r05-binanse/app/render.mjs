// labs/r05-binanse/app/render.mjs — the Binanse look: one hand-built dark "exchange" CSS system (ink-navy with a gold
// accent), the shared page shell, and every page builder. No external assets, fonts, images or CDNs; the mark and
// favicon are inline SVG. Every interpolated value goes through esc() — player-controlled text (ticket subject/body,
// attacker-inbox entries, usernames) is always escaped, so the only place a payload runs is the simulated staff
// browser in bot.mjs. No endpoint list, no hints, no flag, token or PIN anywhere in this module.
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">`
  + `<rect width="32" height="32" rx="7" fill="#f5c518"/>`
  + `<path d="M16 5 27 10.5v11L16 27 5 21.5v-11Z" fill="#0a0d14"/>`
  + `<path d="M16 10 21 12.75v6.5L16 22l-5-2.75v-6.5Z" fill="#f5c518"/></svg>`;

const FAVICON = 'data:image/svg+xml,'
  + '%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E'
  + '%3Crect width=%2232%22 height=%2232%22 rx=%227%22 fill=%22%23f5c518%22/%3E'
  + '%3Cpath d=%22M16 5 27 10.5v11L16 27 5 21.5v-11Z%22 fill=%22%230a0d14%22/%3E'
  + '%3Cpath d=%22M16 10 21 12.75v6.5L16 22l-5-2.75v-6.5Z%22 fill=%22%23f5c518%22/%3E%3C/svg%3E';

const CSS = `
:root{--bg:#0a0d14;--bg2:#0e1220;--card:#141a29;--card2:#1a2132;--line:#232c42;--line2:#1a2132;
--ink:#e9edf5;--muted:#8b95ab;--muted2:#6b7590;--accent:#f5c518;--accent-deep:#d9a90f;--accent-soft:rgba(245,197,24,.13);
--green:#2ecc71;--green-soft:rgba(46,204,113,.14);--red:#e5534b;--red-soft:rgba(229,83,75,.14);
--blue:#4a9eff;--blue-soft:rgba(74,158,255,.14);--radius:14px;--shadow:0 14px 40px rgba(0,0,0,.38)}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
a{color:var(--accent)}
img,svg{display:block;max-width:100%}
h1,h2,h3{line-height:1.15}
p{margin:0 0 12px}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.3px}
.skip{position:absolute;left:-9999px;top:0;background:var(--card);color:var(--ink);padding:10px 16px;border-radius:0 0 8px 0;z-index:60}
.skip:focus{left:0}
.site-header{position:sticky;top:0;z-index:20;background:rgba(10,13,20,.94);backdrop-filter:blur(8px);border-bottom:1px solid var(--line2)}
.header-inner{max-width:1140px;margin:0 auto;padding:11px 20px;display:flex;align-items:center;gap:20px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;color:#fff;text-decoration:none;font-weight:800;font-size:19px;letter-spacing:.2px}
.brand .mark{width:30px;height:30px;flex:none}
.brand small{display:block;font-size:10px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:var(--muted)}
.nav{margin-left:auto;display:flex;gap:3px;overflow-x:auto;scrollbar-width:none}
.nav::-webkit-scrollbar{display:none}
.nav a{color:var(--muted);text-decoration:none;font-size:14px;font-weight:600;padding:8px 11px;border-radius:999px;white-space:nowrap}
.nav a:hover{color:#fff;background:rgba(255,255,255,.06)}
.nav a[aria-current="page"]{color:#fff;background:rgba(255,255,255,.1)}
.wrap{max-width:1140px;margin:0 auto;padding:30px 20px 60px}
.eyebrow{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;color:var(--accent)}
.eyebrow .dot{width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}
.lede{color:var(--muted);font-size:18px;max-width:48ch}
.fineprint{color:var(--muted);font-size:13px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--accent);color:#17130a;border:1px solid var(--accent);border-radius:10px;padding:11px 18px;font-weight:750;font-size:14px;text-decoration:none;cursor:pointer;transition:transform .15s ease,background .15s ease,box-shadow .15s ease}
.btn:hover{background:var(--accent-deep);border-color:var(--accent-deep);transform:translateY(-1px);box-shadow:0 8px 20px rgba(245,197,24,.22)}
.btn.ghost{background:transparent;color:var(--ink);border-color:var(--line)}
.btn.ghost:hover{background:var(--card2);border-color:#39445e;box-shadow:none;color:#fff}
.btn.danger{background:var(--red);border-color:var(--red);color:#fff}
.btn.danger:hover{background:#c73f37;box-shadow:0 8px 20px rgba(229,83,75,.2)}
.btn.small{padding:8px 12px;font-size:12.5px;border-radius:8px}
.btn[aria-disabled="true"]{opacity:.55;cursor:not-allowed}
.hero{display:grid;grid-template-columns:1.05fr .95fr;gap:44px;align-items:center;padding:16px 0 6px}
.hero h1{font-size:clamp(34px,5vw,58px);letter-spacing:-2px;margin:12px 0 14px;line-height:1.02}
.hero h1 span{color:var(--accent)}
.actions{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0 12px}
.hero-visual{background:linear-gradient(160deg,var(--card2),var(--bg2));border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow);padding:22px}
.price-big{font-size:44px;font-weight:850;letter-spacing:-1.6px}
.price-big small{font-size:15px;font-weight:650;color:var(--muted);letter-spacing:0}
.spark{display:flex;align-items:flex-end;gap:3px;height:72px;margin-top:10px}
.spark i{flex:1;background:linear-gradient(180deg,var(--accent),rgba(245,197,24,.12));border-radius:3px 3px 0 0}
.ticker{display:flex;gap:10px;overflow-x:auto;scrollbar-width:none;padding:14px 0 6px}
.ticker::-webkit-scrollbar{display:none}
.tick{flex:none;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:11px 14px;min-width:168px}
.tick .t{font-size:12px;color:var(--muted);font-weight:700;letter-spacing:.6px}
.tick .p{font-size:17px;font-weight:800;margin-top:2px}
.up{color:var(--green)}
.down{color:var(--red)}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:26px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
.stat b{display:block;font-size:24px;letter-spacing:-.6px}
.stat span{color:var(--muted);font-size:12.5px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:22px;box-shadow:var(--shadow)}
.panel h2{margin:0 0 12px;font-size:19px}
.panel h3{margin:0 0 8px;font-size:16px}
.panel p:last-child{margin-bottom:0}
.grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.grid-3{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}
.page-head{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;margin:6px 0 22px;flex-wrap:wrap}
.page-head h1{margin:6px 0 4px;font-size:clamp(28px,4vw,40px);letter-spacing:-1.2px}
.page-head p{margin:0;color:var(--muted)}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:var(--radius);background:var(--card);box-shadow:var(--shadow)}
table{width:100%;border-collapse:collapse;min-width:560px}
th,td{text-align:left;padding:12px 16px;font-size:14px;border-bottom:1px solid var(--line2)}
th{font-size:11px;letter-spacing:.9px;text-transform:uppercase;color:var(--muted);font-weight:750;background:var(--bg2)}
tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--card2)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.coin{display:flex;align-items:center;gap:11px;font-weight:700}
.coin .c-ic{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:850;color:#17130a;background:var(--accent);flex:none}
.coin .c-ic.alt{background:var(--blue);color:#fff}
.coin .c-ic.grey{background:#5b6b8c;color:#fff}
.coin small{display:block;color:var(--muted);font-weight:600;font-size:12px}
.rows{display:grid}
.row{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--line2);font-size:14px}
.row:last-child{border-bottom:0}
.row span{color:var(--muted)}
.row b{text-align:right;overflow-wrap:anywhere}
.wallet{display:inline-flex;align-items:center;gap:8px;background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:9px 13px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;letter-spacing:.3px;overflow-wrap:anywhere}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:750;padding:5px 10px;border-radius:999px;white-space:nowrap;line-height:1.2}
.chip .chip-dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.chip.open{color:var(--accent);background:var(--accent-soft)}
.chip.done{color:var(--green);background:var(--green-soft)}
.chip.alert{color:var(--red);background:var(--red-soft)}
.chip.info{color:var(--blue);background:var(--blue-soft)}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-top:16px}
.feature{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:20px;box-shadow:var(--shadow)}
.feature h3{margin:12px 0 6px;font-size:17px}
.feature p{margin:0;color:var(--muted);font-size:14px}
.feature .icon{width:40px;height:40px;border-radius:12px;background:var(--accent-soft);color:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:900}
.cta{margin-top:26px;background:linear-gradient(135deg,var(--accent),#e0a90e);color:#17130a;border-radius:var(--radius);padding:22px 24px;display:flex;gap:18px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.cta h2{margin:0 0 4px;font-size:19px}
.cta p{margin:0;color:#3a2f0a;font-size:14px;max-width:66ch}
.cta .btn{background:#17130a;border-color:#17130a;color:var(--accent)}
.cta .btn:hover{background:#000;border-color:#000}
.form{display:grid;gap:14px;max-width:460px}
.field{display:grid;gap:6px}
.field label{font-size:13px;font-weight:700;color:var(--ink)}
.field input,.field textarea{width:100%;border:1px solid var(--line);background:var(--bg2);border-radius:10px;padding:11px 13px;font:inherit;font-size:15px;color:var(--ink)}
.field input:focus,.field textarea:focus{outline:3px solid var(--accent-soft);outline-offset:1px;border-color:var(--accent)}
.field textarea{min-height:120px;resize:vertical}
.field .hint{font-size:12px;color:var(--muted)}
.form-row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
.form-row .field{flex:1 1 220px}
.flash{border:1px solid var(--green);background:var(--green-soft);color:var(--green);border-radius:10px;padding:11px 14px;font-size:14px;margin:0 0 18px}
.flash.warn{border-color:var(--red);background:var(--red-soft);color:var(--red)}
.flash.info{border-color:var(--blue);background:var(--blue-soft);color:var(--blue)}
.ticket{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--card);margin-bottom:10px;text-decoration:none;color:var(--ink)}
.ticket:hover{border-color:var(--accent)}
.ticket b{display:block;font-size:15px;overflow-wrap:anywhere}
.ticket span{color:var(--muted);font-size:12.5px}
.thread{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:22px;box-shadow:var(--shadow);overflow-wrap:anywhere}
.thread .subject{font-size:24px;font-weight:800;letter-spacing:-.5px;margin:0 0 4px;overflow-wrap:anywhere}
.thread .meta{color:var(--muted);font-size:13px;margin-bottom:18px}
.thread .body{border:1px solid var(--line);background:var(--bg2);border-radius:10px;padding:16px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}
.inbox{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:22px;box-shadow:var(--shadow)}
.entry{border:1px solid var(--line);background:var(--bg2);border-radius:10px;padding:12px 14px;margin-bottom:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13.5px;word-break:break-all;white-space:pre-wrap}
.entry small{display:block;color:var(--muted);font-family:ui-sans-serif,system-ui,sans-serif;font-size:11px;margin-bottom:6px}
.empty-state{text-align:center;padding:56px 24px;background:var(--card);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow)}
.empty-state .big{font-size:72px;font-weight:900;line-height:1;color:var(--accent);letter-spacing:-4px}
.empty-state h1{margin:10px 0 8px;font-size:26px;letter-spacing:-.6px}
.empty-state p{color:var(--muted);max-width:44ch;margin:0 auto 20px}
.site-footer{background:var(--bg2);color:var(--muted);border-top:1px solid var(--line2);margin-top:60px;padding:42px 20px 26px}
.footer-inner{max-width:1140px;margin:0 auto;display:grid;grid-template-columns:1.5fr 1fr 1fr;gap:28px}
.footer-inner p{color:var(--muted);font-size:13.5px;max-width:40ch;margin:12px 0 0}
.footer-inner h2{font-size:11px;letter-spacing:1.3px;text-transform:uppercase;color:var(--ink);margin:4px 0 10px}
.footer-inner a{display:block;color:var(--muted);text-decoration:none;font-size:14px;padding:3px 0}
.footer-inner a:hover{color:#fff}
.footer-inner .brand{display:flex;color:#fff;padding:0;width:max-content}
.footer-base{max-width:1140px;margin:28px auto 0;border-top:1px solid var(--line2);padding-top:16px;font-size:12px;color:var(--muted2)}
.staff-strip{background:var(--bg2);border-bottom:1px solid var(--line2)}
.staff-strip .header-inner{max-width:1140px;margin:0 auto;padding:7px 20px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:12.5px;color:var(--muted)}
.staff-strip b{color:var(--accent);font-weight:750}
.receipt{background:var(--card);border:1px solid var(--green);border-radius:var(--radius);padding:24px;box-shadow:var(--shadow);text-align:center}
.receipt .ok{width:56px;height:56px;border-radius:50%;background:var(--green-soft);color:var(--green);display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:900;margin:0 auto 14px}
.receipt pre{background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:16px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;word-break:break-all;white-space:pre-wrap;margin:14px 0 0}
@media (max-width:980px){.hero{grid-template-columns:1fr;gap:26px}.hero-visual{order:-1}.stats{grid-template-columns:repeat(2,1fr)}}
@media (max-width:700px){.footer-inner{grid-template-columns:1fr 1fr}.footer-inner>div:first-child{grid-column:1/-1}}
@media (max-width:560px){.wrap{padding:22px 14px 42px}.header-inner{padding:10px 14px;gap:10px}.nav{margin-left:0;width:100%;order:3;flex-wrap:wrap;overflow:visible;gap:2px}.nav a{padding:7px 9px;font-size:13px}.hero h1{letter-spacing:-1px}.actions .btn{flex:1 1 100%}.stat b{font-size:20px}.form-row .field{flex:1 1 100%}}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important;scroll-behavior:auto!important}}
`;

/** A deterministic SVG sparkline-ish bar chart from a price number — decorative, no data fetched. */
function sparkBars(seed) {
  let bars = '';
  for (let i = 0; i < 22; i++) {
    const h = 18 + ((Math.imul(seed + i * 7, 2654435761) >>> 0) % 82);
    bars += `<i style="height:${h}%"></i>`;
  }
  return `<div class="spark" role="img" aria-hidden="true">${bars}</div>`;
}

const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const priceOf = (n) => n >= 1000 ? money(n) : n >= 1 ? n.toFixed(2) : n.toFixed(4);
const pctClass = (n) => (Number(n) >= 0 ? 'up' : 'down');
const pctText = (n) => `${Number(n) >= 0 ? '+' : ''}${Number(n).toFixed(2)}%`;
const coinClass = (s) => ({ BTC: '', ETH: 'alt', BNS: 'alt', SOL: 'grey' }[s] ?? 'grey');

function header(links, active, brandLabel) {
  const items = links.map(([href, label]) =>
    `<a href="${href}"${href === active ? ' aria-current="page"' : ''}>${esc(label)}</a>`).join('');
  return `<header class="site-header"><div class="header-inner">`
    + `<a class="brand" href="/">${MARK}<span>Binanse${brandLabel ? `<small>${esc(brandLabel)}</small>` : ''}</span></a>`
    + `<nav class="nav" aria-label="Main">${items}</nav>`
    + `</div></header>`;
}

function footer() {
  return `<footer class="site-footer"><div class="footer-inner">`
    + `<div><a class="brand" href="/">${MARK}<span>Binanse</span></a>`
    + `<p>Binanse is a fictional crypto exchange built for a security exercise. It is not affiliated with Binance or any real exchange.</p></div>`
    + `<div><h2>Trade</h2><a href="/#markets">Markets</a><a href="/login">Sign in</a><a href="/register">Create account</a></div>`
    + `<div><h2>Help</h2><a href="/tickets">Support</a><a href="/attacker">Research log</a></div>`
    + `</div><p class="footer-base">© 2026 Binanse (demonstration) · No real funds, coins or keys · Fictional product.</p></footer>`;
}

/** The whole site shell. `body` and `headerHtml` must already be escaped/trusted HTML built by the page helpers. */
export function page(title, body, { headerHtml = header([['/#markets', 'Markets'], ['/login', 'Sign in'], ['/register', 'Register']], ''), staff = false } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta name="theme-color" content="#0a0d14">`
    + `<meta name="description" content="Binanse — a fictional crypto exchange for a security exercise.">`
    + `<title>${esc(title)} — Binanse</title>`
    + `<link rel="icon" href="${FAVICON}">`
    + `<style>${CSS}</style></head><body>`
    + `<a class="skip" href="#main">Skip to content</a>`
    + headerHtml
    + (staff ? `<div class="staff-strip"><div class="header-inner"><span>Staff console</span><b>Signed in as devops</b><span>· restricted</span></div></div>` : '')
    + `<main id="main" class="wrap">${body}</main>`
    + footer()
    + `</body></html>`;
}

const PUBLIC_NAV = [['/#markets', 'Markets'], ['/login', 'Sign in'], ['/register', 'Register']];
const USER_NAV = [['/dashboard', 'Dashboard'], ['/tickets', 'Support'], ['/attacker', 'Research log'], ['/logout', 'Sign out']];
const STAFF_NAV = [['/staff', 'Console'], ['/staff/settings', 'Settings'], ['/staff/whitelist', 'Whitelist'], ['/staff/transfer', 'Transfer'], ['/staff/logout', 'Sign out']];

export function publicHeader(active = '') { return header(PUBLIC_NAV, active, ''); }
export function userHeader(active = '') { return header(USER_NAV, active, 'Account'); }
export function staffHeader(active = '') { return header(STAFF_NAV, active, 'Staff'); }

/** Landing page: hero + ticker + market table. `market` comes from seed/market.json. */
export function landingPage(market) {
  const rows = market.map((m) =>
    `<tr><td><div class="coin"><span class="c-ic ${coinClass(m.symbol)}">${esc(m.symbol.slice(0, 3))}</span>`
    + `<span>${esc(m.symbol)}<small>${esc(m.name)}</small></span></div></td>`
    + `<td class="num">$${esc(priceOf(m.price))}</td>`
    + `<td class="num ${pctClass(m.change24h)}">${esc(pctText(m.change24h))}</td>`
    + `<td class="num">${esc(m.volume)}</td></tr>`).join('');
  const ticks = market.map((m) =>
    `<div class="tick"><div class="t">${esc(m.symbol)}</div><div class="p">$${esc(priceOf(m.price))}</div>`
    + `<div class="fineprint ${pctClass(m.change24h)}">${esc(pctText(m.change24h))} · 24h</div></div>`).join('');
  return page('Trade crypto', `
<section class="hero">
  <div>
    <span class="eyebrow"><span class="dot" aria-hidden="true"></span>Live markets</span>
    <h1>Your crypto.<br><span>Your keys.</span></h1>
    <p class="lede">Binanse is a modern exchange with a cold-ledger vault, a fast spot market and a support desk that never sleeps. Open an account and watch your portfolio move.</p>
    <div class="actions">
      <a class="btn" href="/register">Create account</a>
      <a class="btn ghost" href="/login">Sign in</a>
    </div>
    <p class="fineprint">Demo environment — fictional exchange, fictional funds. Nothing here is real money.</p>
  </div>
  <div class="hero-visual">
    <div class="fineprint" style="margin:0 0 6px">BTC / USDT</div>
    <div class="price-big">$67,214<small>.08</small></div>
    <div class="up" style="font-weight:700">+2.41% · 24h</div>
    ${sparkBars(7)}
    <div class="row" style="margin-top:12px"><span>24h volume</span><b>$28.4B</b></div>
  </div>
</section>
<section class="ticker" aria-label="Market ticker">${ticks}</section>
<section class="stats" aria-label="Binanse at a glance">
  <div class="stat"><b>150+</b><span>Listed markets</span></div>
  <div class="stat"><b>$98B</b><span>24h spot volume</span></div>
  <div class="stat"><b>40M</b><span>Registered traders</span></div>
  <div class="stat"><b>Cold</b><span>Ledger vault storage</span></div>
</section>
<section id="markets" aria-labelledby="markets-h">
  <h2 id="markets-h" class="eyebrow" style="margin-bottom:12px">Spot markets</h2>
  <div class="table-wrap">
    <table aria-label="Spot markets">
      <thead><tr><th>Market</th><th class="num">Price</th><th class="num">24h change</th><th class="num">Volume</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</section>
<section class="cta">
  <div><h2>Hold your own keys</h2><p>Binanse keeps the bulk of customer funds in a cold-ledger vault, guarded by a dedicated DevOps engineer. Your coins, your keys.</p></div>
  <a class="btn" href="/register">Get started</a>
</section>`, { headerHtml: publicHeader('/') });
}

export function registerPage(error = '') {
  return page('Create account', `
<div class="page-head"><div><span class="eyebrow">Register</span><h1>Open a Binanse account</h1><p>Free, instant, and fictional.</p></div></div>
${error ? `<div class="flash warn">${esc(error)}</div>` : ''}
<div class="grid-2">
  <section class="panel">
    <h2>Your details</h2>
    <form class="form" action="/register" method="post">
      <div class="field"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required minlength="3" maxlength="32" placeholder="satoshi"></div>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128" placeholder="At least 8 characters"></div>
      <button class="btn" type="submit">Create account</button>
    </form>
  </section>
  <section class="panel">
    <h2>What you get</h2>
    <div class="rows">
      <div class="row"><span>Spot trading</span><b>150+ markets</b></div>
      <div class="row"><span>Wallet</span><b>A unique bn1 address</b></div>
      <div class="row"><span>Support</span><b>A ticket queue</b></div>
      <div class="row"><span>Security</span><b>Cold-ledger vault</b></div>
    </div>
  </section>
</div>`, { headerHtml: publicHeader('/register') });
}

export function loginPage(error = '') {
  return page('Sign in', `
<div class="page-head"><div><span class="eyebrow">Sign in</span><h1>Welcome back</h1><p>Continue to your portfolio.</p></div></div>
${error ? `<div class="flash warn">${esc(error)}</div>` : ''}
<div class="grid-2">
  <section class="panel">
    <h2>Account</h2>
    <form class="form" action="/login" method="post">
      <div class="field"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required placeholder="satoshi"></div>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required placeholder="Your password"></div>
      <button class="btn" type="submit">Sign in</button>
    </form>
  </section>
  <section class="panel">
    <h2>New here?</h2>
    <p>Create a free account to trade, hold funds and contact support.</p>
    <div class="actions" style="margin-top:16px"><a class="btn ghost" href="/register">Create account</a></div>
  </section>
</div>`, { headerHtml: publicHeader('/login') });
}

/** Signed-in dashboard: portfolio, wallet address, balances and quick links. The wallet address carries `data-wallet`. */
export function dashboardPage(user) {
  const balances = user.balances;
  const rows = [['BTC', 'Bitcoin'], ['ETH', 'Ethereum'], ['USDT', 'Tether']].map(([sym, name]) =>
    `<div class="row"><span>${sym} · ${name}</span><b class="mono">${esc(money(balances[sym]))}</b></div>`).join('');
  return page('Dashboard', `
<div class="page-head">
  <div>
    <span class="eyebrow">Portfolio</span>
    <h1>Welcome back, ${esc(user.username)}</h1>
    <p>Your spot wallet and support queue at a glance.</p>
  </div>
  <span class="chip done"><span class="chip-dot" aria-hidden="true"></span>KYC verified</span>
</div>
<div class="grid-2">
  <section class="panel">
    <h2>Your wallet address</h2>
    <p class="fineprint">Use this address to receive funds. It is unique to your account.</p>
    <div class="wallet" data-wallet="${esc(user.wallet)}" title="Your deposit address">${esc(user.wallet)}</div>
  </section>
  <section class="panel">
    <h2>Balances</h2>
    <div class="rows">${rows}</div>
    <p class="fineprint" style="margin-top:12px">Estimated total is illustrative. Withdrawals to a whitelisted address are processed by staff.</p>
  </section>
</div>
<div class="grid-2" style="margin-top:16px">
  <section class="panel">
    <h2>Support</h2>
    <p>Something wrong with a deposit or a trade? Open a ticket and ask staff to review it.</p>
    <div class="actions" style="margin-top:16px"><a class="btn" href="/tickets">Open the support queue</a></div>
  </section>
  <section class="panel">
    <h2>Research log</h2>
    <p>Messages your own experiments have left around the site end up here.</p>
    <div class="actions" style="margin-top:16px"><a class="btn ghost" href="/attacker">Open the research log</a></div>
  </section>
</div>`, { headerHtml: userHeader('/dashboard') });
}

export function ticketsPage(tickets, notice = '') {
  const list = tickets.length
    ? tickets.map((t) =>
      `<a class="ticket" href="/tickets/${t.id}"><span><b>${esc(t.subject)}</b>`
      + `<span>#${t.id} · ${t.reviewed ? 'staff review requested' : 'open'} · ${esc(t.createdAt)}</span></span>`
      + `<span class="chip ${t.reviewed ? 'done' : 'open'}"><span class="chip-dot" aria-hidden="true"></span>${t.reviewed ? 'reviewed' : 'open'}</span></a>`).join('')
    : '<p class="fineprint">No tickets yet. Create one below.</p>';
  return page('Support', `
<div class="page-head"><div><span class="eyebrow">Support</span><h1>Support tickets</h1><p>Describe a problem and a member of staff will review it.</p></div></div>
${notice ? `<div class="flash info">${esc(notice)}</div>` : ''}
<div class="grid-2">
  <section class="panel">
    <h2>New ticket</h2>
    <form class="form" action="/tickets" method="post">
      <div class="field"><label for="subject">Subject</label><input id="subject" name="subject" required maxlength="120" placeholder="Deposit not credited"></div>
      <div class="field"><label for="body">Message</label><textarea id="body" name="body" required maxlength="8192" placeholder="Describe the problem in detail…"></textarea>
      <span class="hint">A staff member will read your message.</span></div>
      <button class="btn" type="submit">Create ticket</button>
    </form>
  </section>
  <section class="panel">
    <h2>Your queue</h2>
    ${list}
    <p class="fineprint" style="margin-top:10px">Messages are shown exactly as you wrote them — nothing here runs as code.</p>
  </section>
</div>`, { headerHtml: userHeader('/tickets') });
}

export function ticketDetailPage(ticket, notice = '') {
  return page(`Ticket #${ticket.id}`, `
<div class="page-head">
  <div><span class="eyebrow">Support · #${ticket.id}</span><h1>Ticket detail</h1></div>
  <span class="chip ${ticket.reviewed ? 'done' : 'open'}"><span class="chip-dot" aria-hidden="true"></span>${ticket.reviewed ? 'staff review requested' : 'open'}</span>
</div>
${notice ? `<div class="flash info">${esc(notice)}</div>` : ''}
<section class="thread">
  <h2 class="subject">${esc(ticket.subject)}</h2>
  <p class="meta">From ${esc(ticket.owner)} · ${esc(ticket.createdAt)}</p>
  <div class="body">${esc(ticket.body)}</div>
  <div class="actions" style="margin-top:18px">
    ${ticket.reviewed
      ? '<span class="chip info"><span class="chip-dot" aria-hidden="true"></span>Queued for staff review</span>'
      : `<form action="/tickets/${ticket.id}/review" method="post"><button class="btn" type="submit">Request staff review</button></form>`}
    <a class="btn ghost" href="/tickets">Back to queue</a>
  </div>
</section>`, { headerHtml: userHeader('/tickets') });
}

export function attackerPage(entries) {
  const list = entries.length
    ? entries.map((e) =>
      `<div class="entry" data-inbox-entry="${e.id}"><small>entry #${e.id} · ${esc(e.at)}</small>${esc(e.body)}</div>`).join('')
    : '<p class="fineprint">No entries captured yet.</p>';
  return page('Research log', `
<div class="page-head"><div><span class="eyebrow">Attacker</span><h1>Research log</h1><p>Anything your own experiments post to the public inbox is collected here, in order.</p></div></div>
<section class="inbox" data-testid="inbox">
  <h2>Captured entries</h2>
  <p class="fineprint">Each entry is shown exactly as received, escaped so it cannot run here.</p>
  ${list}
</section>`, { headerHtml: userHeader('/attacker') });
}

export function staffLoginPage(error = '') {
  return page('Staff sign in', `
<div class="page-head"><div><span class="eyebrow">Staff</span><h1>DevOps console</h1><p>Restricted to Binanse infrastructure staff.</p></div></div>
${error ? `<div class="flash warn">${esc(error)}</div>` : ''}
<div class="grid-2">
  <section class="panel">
    <h2>Sign in</h2>
    <form class="form" action="/staff/login" method="post">
      <div class="field"><label for="token">DevOps access token</label><input id="token" name="token" required autocomplete="off" placeholder="bn_staff token"></div>
      <button class="btn" type="submit">Sign in</button>
    </form>
  </section>
  <section class="panel">
    <h2>Authorized only</h2>
    <p>This console holds the cold-ledger hot wallets. Only the DevOps engineer's session may read or move funds.</p>
    <p class="fineprint">There is no password — access is via a session token.</p>
  </section>
</div>`, { headerHtml: publicHeader('/staff/login') });
}

/** The staff console: "Signed in as devops", hot-wallet balances and links. `vault.balance` carries `data-vault-balance`. */
export function staffConsolePage(vault, whitelistCount) {
  const rows = [['BTC', 'Bitcoin'], ['ETH', 'Ethereum'], ['USDT', 'Tether']].map(([sym, name]) =>
    `<div class="row"><span>${sym} · ${name} (hot wallet)</span><b class="mono">${esc(money(vault.balances[sym]))}</b></div>`).join('');
  return page('Staff console', `
<div class="page-head">
  <div><span class="eyebrow">Infrastructure</span><h1>Hot-wallet console</h1><p>Cold-ledger hot wallets for the Binanse treasury.</p></div>
  <span class="chip alert"><span class="chip-dot" aria-hidden="true"></span>Restricted</span>
</div>
<div class="grid-2">
  <section class="panel">
    <h2>Balances</h2>
    <div class="rows">${rows}</div>
    <p class="fineprint" style="margin-top:12px">Vault total (USDT): <b class="mono" data-vault-balance="${esc(money(vault.balance))}">$${esc(money(vault.balance))}</b></p>
  </section>
  <section class="panel">
    <h2>Actions</h2>
    <div class="rows">
      <div class="row"><span>Settings</span><b><a href="/staff/settings">Withdrawal PIN</a></b></div>
      <div class="row"><span>Whitelist</span><b><a href="/staff/whitelist">${whitelistCount} address(es)</a></b></div>
      <div class="row"><span>Transfer</span><b><a href="/staff/transfer">Move funds</a></b></div>
    </div>
  </section>
</div>`, { headerHtml: staffHeader('/staff'), staff: true });
}

/** Staff settings: shows the random 6-digit withdrawal PIN in a data-pin attribute (masked on screen). */
export function staffSettingsPage(pin) {
  return page('Settings', `
<div class="page-head"><div><span class="eyebrow">Settings</span><h1>Withdrawal PIN</h1><p>The six-digit approval code for cold-ledger transfers.</p></div></div>
<div class="grid-2">
  <section class="panel">
    <h2>Approval code</h2>
    <p>Keep this code secret. Transfers out of the vault require this exact PIN.</p>
    <div class="wallet" data-pin="${esc(pin)}" title="Withdrawal PIN">••••••</div>
    <p class="fineprint" style="margin-top:12px">The PIN is rotated on every deployment.</p>
  </section>
  <section class="panel">
    <h2>Guidance</h2>
    <div class="rows">
      <div class="row"><span>Length</span><b>6 digits</b></div>
      <div class="row"><span>Rotation</span><b>Per deployment</b></div>
      <div class="row"><span>2FA</span><b>Not enforced</b></div>
      <div class="row"><span>Separate approval</span><b>Whitelist + PIN</b></div>
    </div>
  </section>
</div>`, { headerHtml: staffHeader('/staff/settings'), staff: true });
}

export function staffWhitelistPage(addresses, notice = '') {
  const list = addresses.length
    ? addresses.map((a) => `<div class="row"><span class="mono" style="overflow-wrap:anywhere">${esc(a)}</span><b>whitelisted</b></div>`).join('')
    : '<p class="fineprint">No addresses whitelisted yet.</p>';
  return page('Whitelist', `
<div class="page-head"><div><span class="eyebrow">Whitelist</span><h1>Destination addresses</h1><p>Funds may only leave the vault to an address on this list.</p></div></div>
${notice ? `<div class="flash info">${esc(notice)}</div>` : ''}
<div class="grid-2">
  <section class="panel">
    <h2>Add an address</h2>
    <form class="form" action="/staff/whitelist" method="post">
      <div class="field"><label for="address">Address</label><input id="address" name="address" required placeholder="bn1…" pattern="bn1[a-z2-7]{40}"></div>
      <button class="btn" type="submit">Whitelist</button>
    </form>
  </section>
  <section class="panel">
    <h2>Current list</h2>
    <div class="rows">${list}</div>
  </section>
</div>`, { headerHtml: staffHeader('/staff/whitelist'), staff: true });
}

export function staffTransferPage(vault, notice = '') {
  return page('Transfer', `
<div class="page-head"><div><span class="eyebrow">Transfer</span><h1>Vault withdrawal</h1><p>Move the full vault balance to a whitelisted address.</p></div></div>
${notice ? `<div class="flash warn">${esc(notice)}</div>` : ''}
<div class="grid-2">
  <section class="panel">
    <h2>Withdrawal</h2>
    <form class="form" action="/staff/transfer" method="post">
      <div class="field"><label for="address">Destination address</label><input id="address" name="address" required placeholder="bn1…"></div>
      <div class="field"><label for="pin">Withdrawal PIN</label><input id="pin" name="pin" required inputmode="numeric" autocomplete="off" maxlength="6" placeholder="6 digits"></div>
      <div class="field"><label for="amount">Amount (USDT)</label><input id="amount" name="amount" required inputmode="decimal" value="${esc(String(vault.balance))}"></div>
      <button class="btn danger" type="submit">Transfer the whole vault</button>
    </form>
  </section>
  <section class="panel">
    <h2>Vault status</h2>
    <div class="rows">
      <div class="row"><span>Vault balance (USDT)</span><b class="mono" data-vault-balance="${esc(money(vault.balance))}">$${esc(money(vault.balance))}</b></div>
      <div class="row"><span>Destination</span><b>Whitelist only</b></div>
      <div class="row"><span>Approval</span><b>6-digit PIN</b></div>
      <div class="row"><span>Amount</span><b>Whole balance</b></div>
    </div>
  </section>
</div>`, { headerHtml: staffHeader('/staff/transfer'), staff: true });
}

/** The transfer receipt — the only place the flag is ever rendered (data-testid="receipt"). */
export function receiptPage(flag, { address, amount }) {
  return page('Transfer complete', `
<section class="receipt" data-testid="receipt">
  <div class="ok" aria-hidden="true">✓</div>
  <h1 style="margin:0 0 6px">Transfer complete</h1>
  <p>${esc(money(amount))} USDT was moved from the cold-ledger vault to <span class="mono">${esc(address)}</span>.</p>
  <pre>${esc(flag)}</pre>
  <div class="actions" style="justify-content:center;margin-top:18px"><a class="btn ghost" href="/staff">Back to console</a></div>
</section>`, { headerHtml: staffHeader('/staff/transfer'), staff: true });
}

export function notFoundPage() {
  return page('Not found', `
<div class="empty-state">
  <div class="big">404</div>
  <h1>This page is not on the exchange</h1>
  <p>The route you asked for does not exist. Head back to the markets or your dashboard.</p>
  <div class="actions" style="justify-content:center"><a class="btn" href="/">Back to home</a><a class="btn ghost" href="/login">Sign in</a></div>
</div>`);
}

export function serverErrorPage() {
  return page('Something went wrong', `
<div class="empty-state">
  <div class="big">500</div>
  <h1>The order book froze</h1>
  <p>Something failed on our side; your funds are safe. Try again, or return home.</p>
  <div class="actions" style="justify-content:center"><a class="btn" href="/">Back to home</a></div>
</div>`);
}
